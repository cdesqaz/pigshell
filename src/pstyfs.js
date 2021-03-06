/*
 * Copyright (C) 2012-2014 by Coriolis Technologies Pvt Ltd.
 * This program is free software - see the file COPYING for license details.
 */

/*
 * This file implements the client side of PstyFS, a simple network filesystem,
 * whose server side is implemented by psty.py. It allows us expose a selected
 * directory on the desktop to be mounted read-write under pigshell.
 *
 */

var PstyFS = function() {
    PstyFS.base.apply(this, arguments);
};

inherit(PstyFS, HttpFS);

PstyFS.fsname = 'PstyFS';
PstyFS.filesystems = [];

/* Inherit classmethods by hand */
["merge_attrs", "lookup_uri", "lookup_fs"].forEach(function(el) {
    PstyFS[el] = PstyFS.base[el];
});

PstyFS.prototype.dirmime = 'application/vnd.pigshell.dir+json';
PstyFS.prototype.bdlmime = 'application/vnd.pigshell.bundle+json';

var PstyFile = function() {
    PstyFile.base.apply(this, arguments);
    this.mime = 'application/vnd.pigshell.pstyfile';
};

inherit(PstyFile, HttpFile);

PstyFS.fileclass = PstyFile;

PstyFS.prototype.rename = function(srcfile, srcdir, sfilename, dstdir,
    dfilename, opts, cb) {
    var self = this,
        form = new FormData(),
        spath = URI.parse(srcfile.ident).path(),
        dpath = URI.parse(dstdir.ident).path();

    spath = spath.replace(/\/*$/, '');
    dpath = pathjoin(dpath, dfilename);
    if (spath.match(/\.bdl$/)) {
        dpath = dpath + '.bdl';
    }
    form.append("op", "rename");
    form.append("src", spath);
    form.append("dst", dpath);

    self.tx.POST(srcfile.ident, form, opts, pef(cb, function(res) {
        fstack_invaldir(srcdir);
        fstack_invaldir(dstdir);
        return cb(null, null);
    }));
};

/* Same as the ef error filter, but translates error codes */
function pef(cb, f) {
    return function() {
        if (arguments[0]) {
            var args = [].slice.call(arguments),
                msg = args[0].msg,
                errnames = Object.keys(Errno),
                errid = errnames.indexOf(msg),
                err = {};
            if (errid !== -1) {
                err.code = errnames[errid];
                err.msg = Errno[errnames[errid]];
                args[0] = err;
            }
            return cb.apply(this, args);
        }
        return f.apply(this, [].slice.call(arguments, 1));
    };
}

PstyFile.prototype.getmeta = function(opts, cb) {
    var self = this,
        gopts = $.extend({}, opts, {'params': {'op': 'stat'},
            'responseType': 'text'});

    self.fs.tx.GET(self.ident, gopts, ef(cb, function(res) {
        var headers = header_dict(res),
            mime = xhr_getmime(headers) || '';
        if (!mime.match('vnd.pigshell')) {
            return cb("Expected vnd.pigshell-* mime type at " + self.ident);
        }
        var data = $.parseJSON(res.response);
        if (!data) {
            return cb('JSON parsing error for ' + self.ident);
        }
        data._mime_valid = true;
        return cb(null, data);
    }));
};

PstyFile.prototype.update = function(meta, opts, cb) {
    var self = this,
        ufile = self._ufile,
        curmime = ufile ? ufile.mime : null,
        attrlist = ["mtime", "size", "atime", "readable", "writable"],
        mime;

    meta = meta || {};
    mime = meta.mime;

    if (ufile && curmime !== mime) {
        fstack_rmtop(self);
    }
    if (mime && (!self._mime_valid || curmime !== mime)) {
        mergeattr(self, meta, ["_mime_valid"].concat(attrlist));
        var mh = VFS.lookup_media_handler(mime) ||
            VFS.lookup_media_handler('application/octet-stream');
        var mf = new mh.handler(self, meta);
        fstack_addtop(self, mf);
        return mf.update(meta, opts, cb);
    }
    mergeattr(self, meta, attrlist);
    return File.prototype.update.call(self, meta, opts, cb);
};

PstyFile.prototype.putdir = mkblob(function(file, blob, opts, cb) {
    var self = this,
        form = new FormData();

    form.append("op", "put");
    form.append("filename", file);
    form.append("data", blob);

    self.fs.tx.POST(self.ident, form, opts, pef(cb, function(res) {
        return cb(null, null);
    }));
});

PstyFile.prototype.link = function(file, name, opts, cb) {
    var self = this,
        form = new FormData();

    form.append("op", "link");
    form.append("name", name);
    form.append("data", '{"ident": "' + file.ident + '"}');

    self.fs.tx.POST(self.ident, form, opts, pef(cb, function(res) {
        return cb(null, null);
    }));
};

PstyFile.prototype.append = function(item, opts, cb) {
    var self = this;

    to('blob', item, {}, ef(cb, function(blob) {
        var form = new FormData();

        form.append("op", "append");
        form.append("data", blob);
        self.fs.tx.POST(self.ident, form, opts,
            pef(cb, function(res) {
            var data = $.parseJSON(res.response);

            if (!data) {
                return cb("JSON parsing error while appending to " + self.ident);
            }
            self.update(data, opts, ef(cb, function(file) {
                return cb(null, null);
            }));
        }));
    }));
};

PstyFile.prototype.rm = function(file, opts, cb) {
    var self = this,
        form = new FormData();

    form.append("op", "rm");
    form.append("filename", file);

    self.fs.tx.POST(self.ident, form, opts, pef(cb, function(res) {
        return cb(null, null);
    }));
};

PstyFile.prototype.mkdir = function(file, opts, cb) {
    var self = this,
        form = new FormData();

    form.append("op", "mkdir");
    form.append("filename", file);

    self.fs.tx.POST(self.ident, form, opts, pef(cb, function(res) {
        return cb(null, null);
    }));
};

var PstyDir = function(file) {
    PstyDir.base.apply(this, arguments);
    this.files = {};
    this.populated = false;
    this.mime = this.fs.dirmime || 'application/vnd.pigshell.dir+json';
    this.html = sprintf('<div class="pfolder"><a href="%s" target="_blank">%s</a></div>', file.ident, file.name);
    this.cookie = -1;
};

inherit(PstyDir, MediaHandler);

["mkdir", "rm", "putdir", "link"].forEach(function(op) {
    PstyDir.prototype[op] = fstack_invaldir_wrap(op);
});

PstyDir.prototype.readdir = function(opts, cb) {
    var self = this,
        dirmime = self.fs.dirmime || 'application/vnd.pigshell.dir+json',
        bdlmime = self.fs.bdlmime || 'application/vnd.pigshell.bundle+json';

    function makefiles(data) {
        if (self.populated) {
            return cb(null, fstack_topfiles(self.files));
        }

        var flist = [],
            base = URI.parse(self.redirect_url || self.ident),
            bfiles = self.files,
            bdls = [],
            bdlseen = {};
            
        /* Bdls win any aliasing contest */
        data.files.forEach(function(el) {
            var bdlmatch = (el.mime === dirmime) ? el.name.match(/(.*)\.bdl$/) : null;
            if (bdlmatch) {
                bdlseen[bdlmatch[1]] = true;
                bdls.push(el);
            } else {
                flist.push(el);
            }
        });
        flist = flist.filter(function(f) { return !bdlseen[f.name]; });
        flist = flist.concat(bdls);
        self.files = {};
        async.forEachSeries(flist, function(el, lcb) {
            var uri = URI.parse(el.ident),
                ident = base.resolve(uri),
                bdlmatch = (el.mime === dirmime) ? el.name.match(/(.*)\.bdl$/) : null,
                entryname = bdlmatch ? bdlmatch[1] : el.name,
                bfile = bfiles[entryname];

            if (bfile && ident === bfile.ident) {
                if (el.mtime === bfile.mtime && el.size === bfile.size) {
                    self.files[entryname] = bfile;
                    return lcb(null);
                } else {
                    el._mime_valid = true;
                    bfile.update(el, opts, function() {
                        self.files[entryname] = bfile;
                        return lcb(null);
                    });
                }
            } else {
                var klass = self.fs.constructor.fileclass,
                    file = new klass({ident: ident, name: el.name, fs: self.fs});
                el._mime_valid = true;
                file.update(el, opts, function(err, res) {
                    self.files[entryname] = file;
                    return lcb(null);
                });
            }
        }, function(err) {
            self.populated = true;
            return cb(null, fstack_topfiles(self.files));
        });
    }

    if (self.fs.cachedir && self.populated) {
        return cb(null, fstack_topfiles(self.files));
    }
    self.read({context: opts.context, type: "text"}, ef(cb, function(res) {
        var data = parse_json(res);
        if (!data) {
            return cb("JSON parsing error at " + self.ident);
        }
        if (!(opts.readdir && opts.readdir.noupdate)) {
            fstack_base(self).update(data, opts, ef(cb, function(res) {
                var b = fstack_base(res);
                while (b) {
                    if (b === self) {
                        return makefiles(data);
                    }
                    b = b._ufile;
                }
                console.log("PstyDir WTF");
                return res.readdir(opts, cb);
            }));
        } else {
            return makefiles(data);
        }
    }));
};

PstyDir.prototype.update = function(meta, opts, cb) {
    var self = this,
        bdlmatch = self.name.match(/(.*)\.bdl$/),
        bdlmime = self.fs.bdlmime || 'application/vnd.pigshell.bundle+json';

    if (!self._update(meta, opts)) {
        /* Short-circuit update of the stack here */
        return cb(null, fstack_top(self));
    }
    if (bdlmatch) {
        var mh = VFS.lookup_media_handler(bdlmime),
            mf = mh ? new mh.handler(self) : null;
        if (!mh) {
            return cb(null, self);
        }
        fstack_addtop(self, mf);
        return mf.update(meta, opts, cb);
    }
    return File.prototype.update.call(self, meta, opts, cb);
};

PstyDir.prototype._update = function(meta, opts) {
    var self = this,
        data = $.extend({}, meta),
        changed = false;

    if (self.cookie !== data['cookie']) {
        self.populated = false;
        fstack_rmtop(self);
        changed = true;
    }
    mergeattr(self, data, ["mtime", "readable", "writable", "size", "cookie"]);
    return changed;
};

/* unused */
PstyDir.prototype._get_cookie = function(data) {
    var siglist = data.files || [];
    siglist = siglist.map(function(f) {
        return f.name + f.size + f.mtime;
    });
    siglist.push(data.name + data.size + data.mtime);
    return siglist.sort().join('');
};

PstyDir.prototype.unbundle = function(filename, data, opts, cb) {
    var self = this,
        obj = {};

    self.mkdir(filename + '.bdl', opts, function(err, dir) {
        if (!err || err.code === 'EEXIST') {
            self.lookup(filename, opts, ef(cb, function(dir) {
                var pd = fstack_top(dir),
                    pb = fstack_base(dir);
                while (pd && pd.mime !== self.mime) {
                    pd = pd._lfile;
                }
                restoretree.call(pd, data, opts, ef(cb, function() {
                    return cb(null, pb);
                }));
            }));
        } else {
            return cb(err);
        }
    });
};

PstyDir.prototype.rm = function(filename, opts, cb) {
    var self = this;

    function rmbundle(file) {
        var opts2 = $.extend({}, opts);
        opts2.readdir = { noupdate: true };
        rmtree(file, opts2, ef(cb, function() {
            self._lfile.rm(filename + '.bdl', opts, cb);
        }));
    }

    self.lookup(filename, opts, ef(cb, function(file) {
        var l1 = fstack_level(file, 1),
            l2 = fstack_level(file, 2);

        if (l1 && l2 && l1.mime === self.fs.dirmime &&
            l2.mime === self.fs.bdlmime) {
            if (isdir(file) && !file._nodescend) {
                var opts2 = $.extend({}, opts);
                opts2.readdir = { noupdate: true };
                file.readdir(opts2, ef(cb, function(files) {
                    if (Object.keys(files).length) {
                        return cb(E('ENOTEMPTY'));
                    }
                    return rmbundle(l1);
                }));
            } else {
                return rmbundle(l1);
            }
        } else {
            return self._lfile.rm(filename, opts, cb);
        }
    }));
};

var PstyBundle = function(file) {
    PstyBundle.base.apply(this, arguments);
    this.mime = this.fs.bdlmime || 'application/vnd.pigshell.bundle+json';
    this.populated = false;
    this.files = {};
};

inherit(PstyBundle, MediaHandler);

PstyBundle.prototype.update = function(meta, opts, cb) {
    var self = this,
        bdldir = self._lfile,
        opts2 = $.extend({}, opts);

    /*
     * Hidden assumption: If update gets called, there must have been a change.
     * If we need to avoid this, maintain and check cookie/mtime
     */

    function ret(err) {
        //console.log('PstyBundle update: ' + err  + ': ' + self.name);
        fstack_rmbot(self);
        return cb(null, bdldir);
    }

    fstack_rmtop(self);
    self.files = {};
    self.populated = false;

    opts2.readdir = { noupdate: true };
    bdldir.readdir(opts2, function(err, bdlfiles) {
        if (err) {
            return ret(err);
        }
        var metafile = fstack_base(bdlfiles['.meta']);
        if (!metafile) {
            return ret("No meta file");
        }
        metafile.read({'type': 'text', 'context': opts.context}, function(err, res) {
            if (err) {
                return ret(err);
            }
            var dotmeta = $.parseJSON(res);
            if (!dotmeta || !dotmeta.meta) {
                return ret("Meta parsing error");
            }
            self.dotmeta = dotmeta;
            if (dotmeta.meta.type !== 'object') {
                return ret("Unsupported meta format");
            }
            var meta = dotmeta.meta.value,
                ddata = dotmeta.data,
                mime = meta.mime;

            if (!mime) {
                return ret("No mime in meta");
            }

            var myfiles = $.extend({}, bdlfiles);

            delete myfiles['.meta'];
            delete myfiles['.rsrc'];
            if (ddata && ddata.type === 'file') {
                var fname = ddata.value;
                if (!bdlfiles[fname]) {
                    return ret("Data file missing in bundle dir");
                }
                delete myfiles[fname];
                ddata.value = fstack_base(bdlfiles[fname]);
            }

            self.files = myfiles;
            self.populated = true;
            var mh = VFS.lookup_media_handler(mime) ||
                VFS.lookup_media_handler('application/octet-stream');
            var mf = new mh.handler(self, meta);
            fstack_addtop(self, mf);
            return mf.update(meta, opts, cb);
        });
    });
};

PstyBundle.prototype.readdir = function(opts, cb) {
    var self = this;

    if (self.populated) {
        return cb(null, self.files);
    } else {
        self.stat(opts, ef(cb, function(res) {
            return res.readdir(opts, cb);
        }));
    }
};

PstyBundle.prototype.getdata = function(opts, cb) {
    var self = this,
        data = self.dotmeta.data,
        mime = self._ufile ? self._ufile.mime : 'application/octet-stream',
        retstring;

    if (!data) {
        return cb(E('ENODATA'));
    }
    if (data.type === 'file') {
        return data.value.getdata(opts, cb);
    }

    if (data.type === 'direct') {
        retstring = data.value;
    } else if (data.type === 'object') {
        retstring = JSON.stringify(data.value);
    } else {
        return cb("Unknown data type");
    }
    if (opts.type === 'text') {
        return cb(null, retstring);
    } else {
        var blob = new Blob([retstring], {type: mime});
        blob.href = self.ident;
        return cb(null, blob);
    }
};

PstyBundle.prototype.read = PstyBundle.prototype.getdata;

["mkdir", "rm", "putdir", "link", "unbundle"].forEach(function(op) {
    PstyBundle.prototype[op] = fstack_invaldir_wrap(op);
});

var PstyLink = function(file) {
    PstyLink.base.apply(this, arguments);
    this.html = sprintf('<div class="pfile"><a href="%s" target="_blank">%s</a></div>', this.ident, this.name);
    this.mtime = -1;
};

inherit(PstyLink, MediaHandler);

PstyLink.prototype.update = function(meta, opts, cb) {
    var self = this,
        uri = meta['href'],
        linkmeta = meta['meta'],
        opts2 = linkmeta ? {meta: linkmeta} : {};

    opts2.context = opts.context;
    if (self.mtime === meta.mtime) {
        return cb(null, fstack_top(self));
    }
    fstack_rmtop(self);
    mergeattr(self, meta, ["mtime", "size", "readable"]);
    if (!uri) {
        return cb('Invalid link format at ' + self.ident);
    }

    VFS.lookup_uri(uri, opts2, function(err, res) {
        if (err) {
            var klass = self.fs.constructor.fileclass,
                res = new klass({ident: self.ident, name: self.name,
                    fs: self.fs});
            res.error = err;
        }
        fstack_addtop(self, fstack_base(res));
        return cb(err, res);
    });
};

VFS.register_uri_handler('http://localhost:50937', PstyFS, {}, 0);
VFS.register_media_handler('application/vnd.pigshell.dir+json', PstyDir, {}, 100);
VFS.register_media_handler('application/vnd.pigshell.link+json', PstyLink, {}, 100);
VFS.register_media_handler('application/vnd.pigshell.bundle+json', PstyBundle, {}, 100);
