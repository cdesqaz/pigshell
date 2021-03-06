/*
 * Copyright (C) 2012-2014 by Coriolis Technologies Pvt Ltd.
 * This program is free software - see the file COPYING for license details.
 */

function Jfilter(opts) {
    var self = this;

    Jfilter.base.call(self, opts);
    self.matched = false;
    self.itemlist = [];
}

inherit(Jfilter, Command);

Jfilter.prototype.usage = 'jf           -- Javascript filter\n\n' +
    'Usage:\n' +
    '    jf [-g] <expr> [<obj>...]\n' +
    '    jf [-g] [-r <file>] [<obj>...]\n' +
    '    jf -h | --help\n\n' +
    'Options:\n' +
    '    <expr>       Javascript expression, e.g. "$.parseJSON(x)"\n' +
    '    -r <file>    Read file containing Javascript expression\n' +
    '    -g           Gather all input and call <expr> with a list\n' +
    '    <obj>        Object to process\n';

Jfilter.prototype.next = check_next(do_docopt(objargs(function() {
    var self = this,
        gather = self.docopts['-g'];

    if (self.inited === undefined) {
        var exp = self.docopts['<expr>'],
            filename = self.docopts['-r'];

        self.inited = true;
        if (filename) {
            fread.call(self, filename, function(err, res) {
                if (err) {
                    return self.exit(err, filename);
                }
                to('text', res, {}, function(err, str) {
                    if (err) {
                        return self.exit(err, filename);
                    }
                    return get_filter(str);
                });
            });
            return;
        } else {
            return get_filter(exp);
        }
    }
    function get_filter(exp) {
        self.filter = eval_getexp(exp);
        if (isstring(self.filter)) {
            return self.exit(self.filter);
        }
        return next();
    }
    next();
    function next() {
        self.unext({}, cef(self, function(item) {
            if (item === null) {
                if (gather) {
                    return do_filter(self.itemlist, true);
                } else {
                    return self.exit();
                }
            } else {
                if (gather) {
                    self.itemlist.push(item);
                    next();
                } else {
                    do_filter(item);
                }
            }
        }));
    }

    function do_filter(x, exit) {
        var res;
        try {
            res = self.filter(x, self);
        } catch(err) {
            self.errmsg('Caught error: ' + err.message);
            if (exit) {
                return self.exit(false);
            } else {
                return next();
            }
        }
        if (res === undefined) {
            //console.log('Undefined result for: ' + x);
            if (exit) {
                self.exit(false);
            } else {
                next();
            }
        } else if (res === null) {
            self.done = true;
            self.output(res);
        } else {
            if (exit) {
                self.done = true;
            }
            self.output(res);
        }
    }
})));

Command.register("jf", Jfilter);
