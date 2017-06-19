// -*- mode: js; indent-tabs-mode: nil; js-basic-offset: 4 -*-
//
// This file is part of ThingTalk
//
// Copyright 2017 Giovanni Campagna <gcampagn@cs.stanford.edu>
//
// See COPYING for details
"use strict";

const child_process = require('child_process');
const byline = require('byline');

const smt = require('./smtlib');

module.exports = class SmtSolver {
    constructor() {
        this._statements = [];
        this._prelude();
    }

    _prelude() {
        this.add(smt.SetOption('produce-assignments'));
        this.add(smt.SetOption('produce-models'));
        this.add(smt.SetOption('strings-exp'));
        this.add(smt.SetLogic('QF_ALL_SUPPORTED'));
    }

    dump() {
        for (let stmt of this._statements)
            console.log(stmt.toString());
    }

    checkSat() {
        return new Promise((callback, errback) => {
            this.add(smt.CheckSat());
            this.dump();

            let child = child_process.spawn('cvc4', ['--lang', 'smt', '--dump-models']);

            child.stdin.setDefaultEncoding('utf8');
            for (let stmt of this._statements)
                child.stdin.write(stmt.toString());
            child.stdin.end();
            child.stderr.setEncoding('utf8');
            let stderr = byline(child.stderr);
            stderr.on('data', (data) => {
                console.error('SMT-ERR:', data);
            });
            child.stdout.setEncoding('utf8');
            let stdout = byline(child.stdout);
            let sat = undefined;
            let assignment = {};
            let cidx = 0;
            let constants = {};
            stdout.on('data', (line) => {
                console.log('SMT:', line);
                if (line === 'sat') {
                    sat = true;
                    return;
                }
                if (line === 'unsat') {
                    sat = false;
                    return;
                }

                const CONSTANT_REGEX = /; rep: @uc_([A-Za-z0-9_]+)$/;
                let match = CONSTANT_REGEX.exec(line);
                if (match !== null) {
                    constants[match[1]] = cidx++;
                    return;
                }
                const ASSIGN_CONST_REGEX = /\(define-fun ([A-Za-z0-9_.]+) \(\) ([A-Za-z0-9_]+) @uc_([A-Za-z0-9_]+)\)$/
                match = ASSIGN_CONST_REGEX.exec(line);
                if (match !== null) {
                    assignment[match[1]] = constants[match[3]];
                    return;
                }

                const ASSIGN_BOOL_REGEX = /\(define-fun ([A-Za-z0-9_.]+) \(\) Bool (true|false)\)$/;
                match = ASSIGN_BOOL_REGEX.exec(line);
                if (match !== null)
                    assignment[match[1]] = (match[2] === 'true');

                // ignore everything else
            });
            stdout.on('end', () => sat ? callback([true, assignment, constants]) : callback([false, undefined, undefined]));

            child.stdout.on('error', errback);
        });
    }

    add(stmt) {
        this._statements.push(stmt);
    }

    assert(expr) {
        this.add(smt.Assert(expr));
    }
}