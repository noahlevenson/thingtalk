// -*- mode: js; indent-tabs-mode: nil; js-basic-offset: 4 -*-
//
// This file is part of ThingTalk
//
// Copyright 2017 Giovanni Campagna <gcampagn@cs.stanford.edu>
//
// See COPYING for details
"use strict";

const assert = require('assert');

const smt = require('./smtlib');
const SmtSolver = require('./smtsolver');
const Ast = require('./ast');
const Type = require('./type');
const Utils = require('./utils');
const Builtin = require('./builtin');
const { optimizeFilter } = require('./optimize');

function arrayEquals(a, b) {
    if (a === null && b === null)
        return true;
    if (a === null || b === null)
        return false;
    if (a.length !== b.length)
        return false;

    for (var i = 0; i < a.length; i++) {
        if (a[i] !== b[i])
            return false;
    }

    return true;
}

function partiallyEvalFilter(expr, scope, inParamMap) {
    return (function recursiveHelper(expr) {
        if (expr.isTrue || expr.isFalse)
            return expr;
        if (expr.isOr)
            return Ast.BooleanExpression.Or(expr.operands.map(recursiveHelper));
        if (expr.isAnd)
            return Ast.BooleanExpression.And(expr.operands.map(recursiveHelper));
        if (expr.isNot)
            return Ast.BooleanExpression.Not(recursiveHelper(expr.expr));

        let filter = expr.filter;
        // the filter comes from tne Allowed() rule, should it should not have anything funky
        assert(!filter.value.isUndefined && !filter.value.isNull && !filter.value.isVarRef);

        let lhs = inParamMap[filter.name];
        let rhs = filter.value;
        if (!lhs)
            return expr;
        if (lhs.isNull)
            throw new Error('Precondition refers to unspecified parameter');
        if (lhs.isUndefined)
            throw new Error('Unexpected $undefined');
        if (lhs.isVarRef) {
            return Ast.BooleanExpression.Atom(Ast.Filter(scope[lhs.name], filter.operator, filter.value));
        } else {
            let jslhs = lhs.toJS();
            let jsrhs = rhs.toJS();
            let result = Builtin.BinaryOps[filter.operator].op(jslhs, jsrhs);
            if (result === true)
                return Ast.BooleanExpression.True;
            else if (result === false)
                return Ast.BooleanExpression.False;
            else
                throw new TypeError('Partially evaluated filter is not boolean?');
        }
    })(expr);
}

// Verifies that a program is allowed, with the help of an SMT solver

module.exports = class PermissionChecker {
    constructor(schemaRetriever) {
        this._schemaRetriever = schemaRetriever;
        this._solver = new SmtSolver();

        this._add(smt.DeclareDatatype('Location',
            ['loc.home', 'loc.work', 'loc.current_location',
             ['loc.absolute', '(loc.lat Real)', '(loc.lon Real)']]));
        this._types = new Set(['Entity_tt_contact']);
        this._enumtypes = [];

        this._constants = new Map;
        this._constants.set('pi', 'Entity_tt_contact');

        this._classes = {};
        this._fndecls = new Map;
        this._fnparamdecls = [];
        this._asserts = [];
        this._progparamdecls = [];

        this._declareFunction('remote', 'send', {
            kind_type: 'other',
            args: ['__principal'],
            index: { __principal: 0 },
            inReq: { __principal: Type.Entity('tt:contact') },
            inOpt: {},
            out: {}
        });
        this._declareFunction('remote', 'receive', {
            kind_type: 'other',
            args: ['__principal'],
            index: { __principal: 0 },
            inReq: { __principal: Type.Entity('tt:contact') },
            inOpt: {},
            out: {}
        });

        this._asserts.push(smt.Implies(
            smt.Eq('pi', 'param_remote_send___principal'),
                smt.Predicate('Allowed_remote_send', 'pi')));
        this._asserts.push(smt.Implies(
            smt.Eq('pi', 'param_remote_receive___principal'),
                smt.Predicate('Allowed_remote_receive', 'pi')));

        this._constridx = 0;
        this._constrmap = [];
        this._constrrevmap = new Map;
        this._allowedidx = 0;
        this._allowedmap = [];

        this._progvars = new Set;
        this._checkidx = 0;
        this._checkmap = [];
        this._fntypemap = [];
        this._checks = [];
        this._checkrevmap = new Map;
        this._program = null;
    }

    _add(stmt) {
        this._solver.add(stmt);
    }

    check() {
        for (let t of this._types)
            this._add(smt.DeclareSort(t));
        for (let [name, t] of this._enumtypes)
            this._add(smt.DeclareDatatype(name, t.entries.map((e) => name + '.' + e)));
        for (let [name, t] of this._constants.entries())
            this._add(smt.DeclareFun(name, [], t));
        for (let decl of this._fndecls.values())
            this._add(decl);
        for (let decl of this._fnparamdecls)
            this._add(decl);
        for (let decl of this._progparamdecls)
            this._add(decl);
        for (let assert of this._asserts)
            this._solver.assert(assert);
        this._solver.assert(smt.Not(smt.And(...this._checks)));

        return this._solver.checkSat().then(([sat, assignment, constants]) => {
            console.log('CVC4 result: ', sat, assignment);
            if (!sat)
                console.log('Program is allowed');
            else
                console.log('Program not allowed, checking for missing constraints');

            // we still need to rewrite the program to add postconditions
            let newprogram = this._program.clone();
            this._program.rules.forEach((oldrule, i) => {
                this._adjustRule(oldrule, newprogram.rules[i], assignment, constants);
            });
            return newprogram;
        });
    }

    _adjustRule(oldrule, newrule, assignment, constants) {
        var scope = {};
        if (oldrule.trigger)
            this._adjustTrigger(oldrule.trigger, newrule.trigger, scope, assignment, constants);
        let lastPrimitive = newrule.trigger;
        oldrule.queries.forEach((oldquery, i) => {
            this._adjustQuery(oldquery, newrule.queries[i], lastPrimitive, scope, assignment, constants);
            lastPrimitive = newrule.queries[i];
        });
        oldrule.actions.forEach((oldaction, i) => {
            this._adjustAction(oldaction, newrule.actions[i], lastPrimitive, scope, assignment, constants);
        });
    }

    _getRelevantRules(fn) {
        let preconditions = [], postconditions = [];
        let rules = [];
        for (let j = 0; j < this._allowedmap.length; j++) {
            let allowedvar = 'allowed_' + this._allowedmap[j];
            let allowed = this._allowedmap[j];
            if (fn.selector.isBuiltin) {
                if (allowed.kind === 'builtin' && allowed.channel === 'notify')
                    rules.push(allowed);
            } else if (allowed.kind === fn.selector.kind &&
                       allowed.channel === fn.channel) {
                rules.push(allowed);
            }
        }
        for (let rule of rules) {
            preconditions.push(rule.precondition);
            postconditions.push(Ast.BooleanExpression.Or([Ast.BooleanExpression.Not(rule.precondition), rule.postcondition]));
        }

        console.log('Found ' + rules.length + ' relevant permission rules');
        return [Ast.BooleanExpression.Or(preconditions), Ast.BooleanExpression.And(postconditions)];
    }

    _computeCondition(primitive, scope, condition) {
        let inParamMap = {};
        for (let inParam of primitive.in_params)
            inParamMap[inParam.name] = inParam.value;

        return optimizeFilter(partiallyEvalFilter(condition, scope, inParamMap));
    }

    _adjustQuery(oldquery, newquery, newlastprimitive, scope, assignment, constants) {
        for (let outParam of newquery.out_params)
            scope[outParam.name] = outParam.value;

        let [precondition, postcondition] = this._getRelevantRules(oldquery);
        let name = this._checkrevmap.get(oldquery);
        if (!assignment || assignment['check_' + name]) {
            console.log('Function ' + oldquery + ' is allowed');
            precondition = Ast.BooleanExpression.True;
        } else {
            console.log('Function ' + oldquery + ' is not (always) allowed');
            precondition = this._computeCondition(newquery, scope, precondition);
        }

        postcondition = this._computeCondition(newquery, scope, postcondition);
        if (precondition.isFalse)
            throw new Error('Precondition is never satisfied');
        if (postcondition.isFalse)
            throw new Error('Postcondition is never satisfied');
        if (!precondition.isTrue && !newlastprimitive)
            throw new TypeError('??? Query precondition is not statically true or false, but there is no trigger?');

        newlastprimitive.filter = Ast.BooleanExpression.And([newlastprimitive.filter, precondition]);
        newquery.filter = Ast.BooleanExpression.And([newquery.filter, postcondition]);
    }

    _adjustAction(oldaction, newaction, newlastprimitive, scope, assignment, constants) {
        let [precondition, postcondition] = this._getRelevantRules(oldaction);
        let name = this._checkrevmap.get(oldaction);
        if (!assignment || assignment['check_' + name]) {
            console.log('Function ' + oldaction + ' is allowed');
            precondition = Ast.BooleanExpression.True;
        } else {
            console.log('Function ' + oldaction + ' is not (always) allowed');
            precondition = this._computeCondition(newaction, scope, precondition);
        }

        postcondition = this._computeCondition(newaction, scope, postcondition);
        if (precondition.isFalse)
            throw new Error('Precondition is never satisfied');
        if (!precondition.isTrue && !newlastprimitive)
            throw new TypeError('??? Action precondition is not statically true or false, but there is no trigger?');

        if (!postcondition.isTrue)
            throw new TypeError('??? Actions cannot have postconditions');
        newlastprimitive.filter = Ast.BooleanExpression.And([newlastprimitive.filter, precondition]);
    }

    _adjustTrigger(oldtrigger, newtrigger, scope, assignment, constants) {
        for (let outParam of newtrigger.out_params)
            scope[outParam.name] = outParam.value;

        let [precondition, postcondition] = this._getRelevantRules(oldtrigger);
        let name = this._checkrevmap.get(oldtrigger);
        if (!assignment || assignment['check_' + name]) {
            console.log('Function ' + oldtrigger + ' is allowed');
            precondition = Ast.BooleanExpression.True;
        } else {
            console.log('Function ' + oldtrigger + ' is not (always) allowed');
            precondition = this._computeCondition(newtrigger, scope, precondition);
        }

        postcondition = this._computeCondition(newtrigger, scope, postcondition);
        if (precondition.isFalse)
            throw new Error('Precondition is never satisfied');
        if (postcondition.isFalse)
            throw new Error('Postcondition is never satisfied');
        if (!precondition.isTrue)
            throw new Error('??? Trigger precondition is not statically true or false?');

        newtrigger.filter =  Ast.BooleanExpression.And([newtrigger.filter, postcondition]);
    }

    _makeEnumType(type) {
        for (let [name, enumType] of this._enumtypes) {
            if (arrayEquals(type.entries, enumType.entries))
                return name;
        }
        let name = 'Enum_' + this._enumtypes.length;
        this._enumtypes.push([name, type]);
        return name;
    }

    _typeToSmtType(type) {
        if (type.isArray)
            return new smt.SExpr('Set', this._typeToSmtType(type.elem));
        if (type.isNumber || type.isMeasure)
            return 'Real';
        if (type.isBoolean)
            return 'Bool';
        if (type.isString)
            return 'String';
        if (type.isLocation)
            return 'Location';
        if (type.isTime || type.isDate)
            return 'Int';
        if (type.isEntity) {
            let t = 'Entity_' + type.type.replace(/[^A-Za-z0-9_]/g, '_');
            this._types.add(t);
            return t;
        }
        if (type.isEnum)
            return this._makeEnumType(type);

        throw new TypeError('Unsupported type ' + type);
    }

    _declareFunction(kind, fn, def) {
        kind = kind.replace(/[^A-Za-z0-9_]/g, '_');
        let allowed = 'Allowed_' + kind + '_' + fn;
        if (this._fndecls.has(allowed))
            return kind + '_' + fn;
        this._fndecls.set(allowed, smt.DeclareFun(allowed, ['Entity_tt_contact'], 'Bool'));
        for (let arg of def.args) {
            let p = 'param_' + kind + '_' + fn + '_' + arg;
            let type = def.inReq[arg] || def.inOpt[arg] || def.out[arg];
            if (type.isTime)
                this._asserts.push(smt.And(smt.GEq(p, 0), smt.LEq(p, 86400)));
            this._fnparamdecls.push(smt.DeclareFun(p, [], this._typeToSmtType(type)));
        }
        if (kind in this._classes) {
            if (this._classes[kind].extends === 'remote') {
                this._asserts.push(smt.Implies(
                    smt.Eq('pi', 'param_'+ kind + '_' + fn + '___principal'),
                    smt.Predicate(allowed, 'pi')));
            }
        }
        return kind + '_' + fn;
    }

    _locToSmtValue(loc) {
        if (loc.isRelative)
            return 'loc.' + loc.value.relativeTag;

        return new smt.SExpr('loc.absolute', loc.lat, loc.lon);
    }

    _encodeEntityValue(ev) {
        return ev.replace(/[^A-Za-z0-9]/g, (c) =>
            '_' + c.charCodeAt(0).toString(16).toUpperCase());
    }

    _entityToSmtValue(entityValue, entityType) {
        entityType = entityType.replace(/[^A-Za-z0-9_]/g, '_');
        entityValue = this._encodeEntityValue(entityValue);
        let name = 'entity_' + entityType + '.' + entityValue;
        this._constants.set(name, 'Entity_' + entityType);
        return name;
    }

    _enumToSmtValue(enumerant, type) {
        let typename = this._makeEnumType(type);
        return typename + '.' + enumerant;
    }

    _valueToSmtValue(v, type) {
        if (v.isVarRef)
            throw new TypeError('Unexpected var ref in filter');
        if (v.isUndefined || v.isNull)
            throw new TypeError('Unexpected null or undefined TT value');
        if (v.isBoolean)
            return v.value ? 'true' : 'false';
        if (v.isString)
            return smt.StringLiteral(v.value);
        if (v.isNumber || v.isMeasure)
            return String(v.toJS()); // toJS() normalizes the measurement
        if (v.isLocation)
            return this._locToSmtValue(v.value);
        if (v.isEntity)
            return this._entityToSmtValue(v.value, v.type);
        if (v.isEnum)
            return this._enumToSmtValue(v.value, type);
        if (v.isTime)
            return String(v.hour * 3600 + v.minute * 60);
        if (v.isDate)
            return String(v.value.getTime())
        throw new TypeError('Unsupported value ' + v);
    }

    _booleanConstraintToSmt(fn, fndef, constr, isPrecondition) {
        if (constr.isTrue)
            return 'true';
        if (constr.isFalse)
            return 'false';
        let name = this._constridx++;
        this._constrmap[name] = constr;
        this._constrrevmap.set(constr, name);

        if (constr.isAnd)
            return smt.Named('constr_' + name,
                smt.And(...constr.operands.map((o) => this._booleanConstraintToSmt(fn, fndef, o, isPrecondition))));
        if (constr.isOr)
            return smt.Named('constr_' + name,
                smt.Or(...constr.operands.map((o) => this._booleanConstraintToSmt(fn, fndef, o, isPrecondition))));
        if (constr.isNot)
            return smt.Named('constr_' + name,
                smt.Not(this._booleanConstraintToSmt(fn, fndef, constr.expr, isPrecondition)));

        let filter = constr.filter;
        let param = 'param_' + fn + '_' + filter.name;
        let paramType;
        if (isPrecondition)
            paramType = fndef.inReq[filter.name] || fndef.inOpt[filter.name];
        else
            paramType = fndef.out[filter.name];
        if (!paramType)
            throw new TypeError('Invalid parameter name ' + filter.name);
        if (filter.operator === 'contains')
            paramType = paramType.elem;
        let value = this._valueToSmtValue(filter.value, paramType);
        return smt.Named('constr_' + name, this._filterToSmt(filter.operator, param, value));
    }

    _filterToSmt(operator, param, value) {
        switch (operator) {
        case '=':
            return smt.Eq(param, value);
        case '>=':
            return smt.GEq(param, value);
        case '<=':
            return smt.LEq(param, value);
        case '>':
            return smt.GT(param, value);
        case '<':
            return smt.LT(param, value);
        case '=~':
            return smt.Predicate('str.contains', param, value);
        case 'contains':
            return smt.Predicate('member', value, param);
        default:
            throw new TypeError('Unsupported operator ' + operator);
        }
    }

    allowed(allowed) {
        return Utils.getSchemaForSelector(this._schemaRetriever,
            allowed.kind,
            allowed.channel,
            allowed.channelType).then((schema) => {
            let fnvar = this._declareFunction(allowed.kind, allowed.channel, schema);
            let name = this._allowedidx++;
            this._allowedmap[name] = allowed;
            this._constants.set('precon_' + name, 'Bool');

            this._asserts.push(smt.Eq('precon_' + name,
                this._booleanConstraintToSmt(fnvar, schema, optimizeFilter(allowed.precondition), true)));
            this._asserts.push(smt.Implies('precon_' + name,
                smt.Named('allowed_' + name,
                    smt.Predicate('Allowed_' + fnvar, 'pi'))));
            this._asserts.push(smt.Implies('precon_' + name,
                this._booleanConstraintToSmt(fnvar, schema, optimizeFilter(allowed.postcondition), false)));
        });
    }

    addProgram(principal, prog) {
        this._program = prog;

        for (let classdef of prog.classes)
            this._classes[classdef.name] = classdef;

        this._asserts.push(smt.Eq('pi', this._valueToSmtValue(principal)));

        return Promise.all(prog.rules.map((r) => this.addRule(r)));
    }

    addRule(rule) {
        var scope = {};
        return new Promise((callback, errback) => {
            if (rule.trigger)
                callback(this._addFunction(rule.trigger, 'triggers', scope, rule.trigger));
            else
                callback();
        }).then(() => {
            function loop(i) {
                if (i === rule.queries.length)
                    return Promise.resolve();

                return this._addFunction(rule.queries[i], 'queries', scope, rule.queries[i])
                    .then(loop.call(this, i+1));
            }
            return loop.call(this, 0);
        }).then(() => {
            return Promise.all(rule.actions.map((a) => {
                if (a.selector.isBuiltin)
                    return this._addBuiltinNotify(a, scope);
                else
                    return this._addFunction(a, 'actions', scope, a);
            }));
        });
    }

    _addBuiltinNotify(ast, scope) {
        return this._addFunction(Ast.RulePart(Ast.Selector.Device('builtin', null, null), 'notify', [], Ast.BooleanExpression.True, []), 'actions', scope, ast);
    }

    _getSchema(fn, fnType) {
        if (fn.schema) {
            return Promise.resolve(fn.schema);
        } else {
            return Utils.getSchemaForSelector(this._schemaRetriever, fn.selector.kind, fn.channel, fnType, false, this._classes)
                .then((schema) => {
                    fn.schema = schema;
                    return schema;
                });
        }
    }

    _getVarName(prefix, type) {
        let idx = 0;
        let vname = 'prog_' + prefix + '_' + idx;
        while (this._constants.has(vname))
            vname = 'prog_' + prefix + '_' + (++idx);
        this._constants.set(vname, this._typeToSmtType(type));
        return vname;
    }

    _processFilter(ast, fnvar, schema) {
        if (ast.isTrue)
            return 'true';
        if (ast.isFalse)
            return 'false';
        if (ast.isAnd)
            return smt.And(...ast.operands.map((o) => this._processFilter(o, fnvar, schema)));
        if (ast.isOr)
            return smt.Or(...ast.operands.map((o) => this._processFilter(o, fnvar, schema)));
        if (ast.isNot)
            return smt.Not(this._processFilter(ast.expr, fnvar, schema));

        let filter = ast.filter;
        let pname = 'param_' + fnvar + '_' + filter.name;
        let ptype = schema.out[filter.name];
        if (filter.operator === 'contains')
            ptype = ptype.elem;
        if (filter.value.isNull || filter.value.isUndefined)
            return 'true';
        if (filter.value.isVarRef)
            return this._filterToSmt(filter.operator, pname, scope[filter.value.name]);
        else
            return this._filterToSmt(filter.operator, pname, this._valueToSmtValue(filter.value, ptype));
    }

    _addFunction(fn, fnType, scope, originalFn) {
        return this._getSchema(fn, fnType).then((schema) => {
            var fnvar = this._declareFunction(fn.selector.kind, fn.channel, schema);
            for (let inParam of fn.in_params) {
                let pname = 'param_' + fnvar + '_' + inParam.name;
                let ptype = schema.inReq[inParam.name] || schema.inOpt[inParam.name];
                if (inParam.value.isNull || inParam.value.isUndefined)
                    continue;
                if (inParam.value.isVarRef)
                    this._asserts.push(smt.Eq(pname, scope[inParam.value.name]));
                else
                    this._asserts.push(smt.Eq(pname, this._valueToSmtValue(inParam.value, ptype)));
            }
            this._asserts.push(this._processFilter(optimizeFilter(fn.filter), fnvar, schema));

            for (let outParam of fn.out_params) {
                let pname = 'param_' + fnvar + '_' + outParam.value;
                let ptype = schema.out[outParam.value];
                let vname = this._getVarName(outParam.name, ptype);
                this._asserts.push(smt.Eq(vname, pname));
                scope[outParam.name] = vname;
            }

            let name = this._checkidx++;
            this._checkmap[name] = fn;
            this._fntypemap[name] = fnType;
            this._checkrevmap.set(originalFn, name);
            this._checks.push(smt.Named('check_' + name,
                smt.Predicate('Allowed_' + fnvar, 'pi')));
        });
    }
}