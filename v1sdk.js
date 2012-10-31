var require = function (file, cwd) {
    var resolved = require.resolve(file, cwd || '/');
    var mod = require.modules[resolved];
    if (!mod) throw new Error(
        'Failed to resolve module ' + file + ', tried ' + resolved
    );
    var cached = require.cache[resolved];
    var res = cached? cached.exports : mod();
    return res;
};

(function(){
require.paths = [];
require.modules = {};
require.cache = {};
require.extensions = [".js",".coffee",".json"];

require._core = {
    'assert': true,
    'events': true,
    'fs': true,
    'path': true,
    'vm': true
};

require.resolve = (function () {
    return function (x, cwd) {
        if (!cwd) cwd = '/';
        
        if (require._core[x]) return x;
        var path = require.modules.path();
        cwd = path.resolve('/', cwd);
        var y = cwd || '/';
        
        if (x.match(/^(?:\.\.?\/|\/)/)) {
            var m = loadAsFileSync(path.resolve(y, x))
                || loadAsDirectorySync(path.resolve(y, x));
            if (m) return m;
        }
        
        var n = loadNodeModulesSync(x, y);
        if (n) return n;
        
        throw new Error("Cannot find module '" + x + "'");
        
        function loadAsFileSync (x) {
            x = path.normalize(x);
            if (require.modules[x]) {
                return x;
            }
            
            for (var i = 0; i < require.extensions.length; i++) {
                var ext = require.extensions[i];
                if (require.modules[x + ext]) return x + ext;
            }
        }
        
        function loadAsDirectorySync (x) {
            x = x.replace(/\/+$/, '');
            var pkgfile = path.normalize(x + '/package.json');
            if (require.modules[pkgfile]) {
                var pkg = require.modules[pkgfile]();
                var b = pkg.browserify;
                if (typeof b === 'object' && b.main) {
                    var m = loadAsFileSync(path.resolve(x, b.main));
                    if (m) return m;
                }
                else if (typeof b === 'string') {
                    var m = loadAsFileSync(path.resolve(x, b));
                    if (m) return m;
                }
                else if (pkg.main) {
                    var m = loadAsFileSync(path.resolve(x, pkg.main));
                    if (m) return m;
                }
            }
            
            return loadAsFileSync(x + '/index');
        }
        
        function loadNodeModulesSync (x, start) {
            var dirs = nodeModulesPathsSync(start);
            for (var i = 0; i < dirs.length; i++) {
                var dir = dirs[i];
                var m = loadAsFileSync(dir + '/' + x);
                if (m) return m;
                var n = loadAsDirectorySync(dir + '/' + x);
                if (n) return n;
            }
            
            var m = loadAsFileSync(x);
            if (m) return m;
        }
        
        function nodeModulesPathsSync (start) {
            var parts;
            if (start === '/') parts = [ '' ];
            else parts = path.normalize(start).split('/');
            
            var dirs = [];
            for (var i = parts.length - 1; i >= 0; i--) {
                if (parts[i] === 'node_modules') continue;
                var dir = parts.slice(0, i + 1).join('/') + '/node_modules';
                dirs.push(dir);
            }
            
            return dirs;
        }
    };
})();

require.alias = function (from, to) {
    var path = require.modules.path();
    var res = null;
    try {
        res = require.resolve(from + '/package.json', '/');
    }
    catch (err) {
        res = require.resolve(from, '/');
    }
    var basedir = path.dirname(res);
    
    var keys = (Object.keys || function (obj) {
        var res = [];
        for (var key in obj) res.push(key);
        return res;
    })(require.modules);
    
    for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        if (key.slice(0, basedir.length + 1) === basedir + '/') {
            var f = key.slice(basedir.length);
            require.modules[to + f] = require.modules[basedir + f];
        }
        else if (key === basedir) {
            require.modules[to] = require.modules[basedir];
        }
    }
};

(function () {
    var process = {};
    var global = typeof window !== 'undefined' ? window : {};
    var definedProcess = false;
    
    require.define = function (filename, fn) {
        if (!definedProcess && require.modules.__browserify_process) {
            process = require.modules.__browserify_process();
            definedProcess = true;
        }
        
        var dirname = require._core[filename]
            ? ''
            : require.modules.path().dirname(filename)
        ;
        
        var require_ = function (file) {
            var requiredModule = require(file, dirname);
            var cached = require.cache[require.resolve(file, dirname)];

            if (cached && cached.parent === null) {
                cached.parent = module_;
            }

            return requiredModule;
        };
        require_.resolve = function (name) {
            return require.resolve(name, dirname);
        };
        require_.modules = require.modules;
        require_.define = require.define;
        require_.cache = require.cache;
        var module_ = {
            id : filename,
            filename: filename,
            exports : {},
            loaded : false,
            parent: null
        };
        
        require.modules[filename] = function () {
            require.cache[filename] = module_;
            fn.call(
                module_.exports,
                require_,
                module_,
                module_.exports,
                dirname,
                filename,
                process,
                global
            );
            module_.loaded = true;
            return module_.exports;
        };
    };
})();


require.define("path",function(require,module,exports,__dirname,__filename,process,global){function filter (xs, fn) {
    var res = [];
    for (var i = 0; i < xs.length; i++) {
        if (fn(xs[i], i, xs)) res.push(xs[i]);
    }
    return res;
}

// resolves . and .. elements in a path array with directory names there
// must be no slashes, empty elements, or device names (c:\) in the array
// (so also no leading and trailing slashes - it does not distinguish
// relative and absolute paths)
function normalizeArray(parts, allowAboveRoot) {
  // if the path tries to go above the root, `up` ends up > 0
  var up = 0;
  for (var i = parts.length; i >= 0; i--) {
    var last = parts[i];
    if (last == '.') {
      parts.splice(i, 1);
    } else if (last === '..') {
      parts.splice(i, 1);
      up++;
    } else if (up) {
      parts.splice(i, 1);
      up--;
    }
  }

  // if the path is allowed to go above the root, restore leading ..s
  if (allowAboveRoot) {
    for (; up--; up) {
      parts.unshift('..');
    }
  }

  return parts;
}

// Regex to split a filename into [*, dir, basename, ext]
// posix version
var splitPathRe = /^(.+\/(?!$)|\/)?((?:.+?)?(\.[^.]*)?)$/;

// path.resolve([from ...], to)
// posix version
exports.resolve = function() {
var resolvedPath = '',
    resolvedAbsolute = false;

for (var i = arguments.length; i >= -1 && !resolvedAbsolute; i--) {
  var path = (i >= 0)
      ? arguments[i]
      : process.cwd();

  // Skip empty and invalid entries
  if (typeof path !== 'string' || !path) {
    continue;
  }

  resolvedPath = path + '/' + resolvedPath;
  resolvedAbsolute = path.charAt(0) === '/';
}

// At this point the path should be resolved to a full absolute path, but
// handle relative paths to be safe (might happen when process.cwd() fails)

// Normalize the path
resolvedPath = normalizeArray(filter(resolvedPath.split('/'), function(p) {
    return !!p;
  }), !resolvedAbsolute).join('/');

  return ((resolvedAbsolute ? '/' : '') + resolvedPath) || '.';
};

// path.normalize(path)
// posix version
exports.normalize = function(path) {
var isAbsolute = path.charAt(0) === '/',
    trailingSlash = path.slice(-1) === '/';

// Normalize the path
path = normalizeArray(filter(path.split('/'), function(p) {
    return !!p;
  }), !isAbsolute).join('/');

  if (!path && !isAbsolute) {
    path = '.';
  }
  if (path && trailingSlash) {
    path += '/';
  }
  
  return (isAbsolute ? '/' : '') + path;
};


// posix version
exports.join = function() {
  var paths = Array.prototype.slice.call(arguments, 0);
  return exports.normalize(filter(paths, function(p, index) {
    return p && typeof p === 'string';
  }).join('/'));
};


exports.dirname = function(path) {
  var dir = splitPathRe.exec(path)[1] || '';
  var isWindows = false;
  if (!dir) {
    // No dirname
    return '.';
  } else if (dir.length === 1 ||
      (isWindows && dir.length <= 3 && dir.charAt(1) === ':')) {
    // It is just a slash or a drive letter with a slash
    return dir;
  } else {
    // It is a full dirname, strip trailing slash
    return dir.substring(0, dir.length - 1);
  }
};


exports.basename = function(path, ext) {
  var f = splitPathRe.exec(path)[2] || '';
  // TODO: make this comparison case-insensitive on windows?
  if (ext && f.substr(-1 * ext.length) === ext) {
    f = f.substr(0, f.length - ext.length);
  }
  return f;
};


exports.extname = function(path) {
  return splitPathRe.exec(path)[3] || '';
};

});

require.define("__browserify_process",function(require,module,exports,__dirname,__filename,process,global){var process = module.exports = {};

process.nextTick = (function () {
    var canSetImmediate = typeof window !== 'undefined'
        && window.setImmediate;
    var canPost = typeof window !== 'undefined'
        && window.postMessage && window.addEventListener
    ;

    if (canSetImmediate) {
        return window.setImmediate;
    }

    if (canPost) {
        var queue = [];
        window.addEventListener('message', function (ev) {
            if (ev.source === window && ev.data === 'browserify-tick') {
                ev.stopPropagation();
                if (queue.length > 0) {
                    var fn = queue.shift();
                    fn();
                }
            }
        }, true);

        return function nextTick(fn) {
            queue.push(fn);
            window.postMessage('browserify-tick', '*');
        };
    }

    return function nextTick(fn) {
        setTimeout(fn, 0);
    };
})();

process.title = 'browser';
process.browser = true;
process.env = {};
process.argv = [];

process.binding = function (name) {
    if (name === 'evals') return (require)('vm')
    else throw new Error('No such module. (Possibly not yet loaded)')
};

(function () {
    var cwd = '/';
    var path;
    process.cwd = function () { return cwd };
    process.chdir = function (dir) {
        if (!path) path = require('path');
        cwd = path.resolve(dir, cwd);
    };
})();

});

require.define("/package.json",function(require,module,exports,__dirname,__filename,process,global){module.exports = {}
});

require.define("/v1meta.coffee",function(require,module,exports,__dirname,__filename,process,global){(function() {
  var AssetClassBase, V1Meta, V1Transaction, asset_dict_filter, client, et, url, util,
    __indexOf = [].indexOf || function(item) { for (var i = 0, l = this.length; i < l; i++) { if (i in this && this[i] === item) return i; } return -1; },
    __bind = function(fn, me){ return function(){ return fn.apply(me, arguments); }; },
    __hasProp = {}.hasOwnProperty,
    __extends = function(child, parent) { for (var key in parent) { if (__hasProp.call(parent, key)) child[key] = parent[key]; } function ctor() { this.constructor = child; } ctor.prototype = parent.prototype; child.prototype = new ctor(); child.__super__ = parent.prototype; return child; };

  client = require('./client');

  et = require('elementtree');

  util = require('util');

  url = require('url');

  asset_dict_filter = function(dict) {
    var k, output, v;
    output = {};
    for (k in dict) {
      v = dict[k];
      if ((v != null) && ((v != null ? v.length : void 0) > 0) && (v !== "")) {
        output[k] = v;
      }
    }
    return output;
  };

  AssetClassBase = (function() {

    function AssetClassBase(_v1_id, _v1_transaction) {
      this._v1_id = _v1_id;
      this._v1_transaction = _v1_transaction;
      this._v1_new_data = {};
      this._v1_current_data = {};
      return this;
    }

    AssetClassBase.prototype.with_data = function(data) {
      this._v1_new_data = {};
      this._v1_current_data = data;
      return this;
    };

    AssetClassBase.prototype.pending = function(data) {
      this._v1_new_data = data;
      return this;
    };

    AssetClassBase.prototype.create_in_context = function(asste_type, data) {
      return pass;
    };

    AssetClassBase.prototype.url = function() {
      var v1meta;
      v1meta = this._v1_v1meta;
      return url.format({
        protocol: v1meta.server.protocol,
        hostname: v1meta.server.hostname,
        port: v1meta.server.port,
        pathname: v1meta.server.instance + '/assetdetail.v1',
        query: {
          oid: this._v1_id
        }
      });
    };

    AssetClassBase.prototype._v1_get = function(attr) {
      var _ref;
      return (_ref = this._v1_new_data[attr]) != null ? _ref : this._v1_current_data[attr];
    };

    AssetClassBase.prototype._v1_set = function(attr, value) {
      if (!(this._v1_transaction != null)) {
        throw "Properties may only be set on assets having a _v1_transaction";
      }
      this._v1_new_data[attr] = value;
      return this._v1_transaction.add_to_dirty(this);
    };

    AssetClassBase.prototype.toString = function() {
      var current, newdata, output;
      current = asset_dict_filter(this._v1_current_data);
      newdata = asset_dict_filter(this._v1_new_data);
      output = "" + this._v1_asset_type_name + "('" + this._v1_id + "')";
      if (Object.keys(current).length > 0) {
        output = output + (".with_data(\n" + (util.inspect(current)) + "})");
      }
      if (Object.keys(newdata).length > 0) {
        output = output + ("\n.pending(\n" + (util.inspect(newdata)) + "})");
      }
      return output;
    };

    return AssetClassBase;

  })();

  Object.defineProperty(AssetClassBase.prototype, "data", {
    get: (function() {
      return this._v1_current_data;
    }),
    enumerable: true
  });

  V1Transaction = (function() {

    function V1Transaction(query_results, v1meta) {
      this.query_results = query_results != null ? query_results : [];
      this.v1meta = v1meta;
      this.dirty_assets = [];
    }

    V1Transaction.prototype.add_to_dirty = function(asset) {
      if (__indexOf.call(this.dirty_asset, asset) < 0) {
        return this.dirty_assets.push(asset);
      }
    };

    V1Transaction.prototype.create = function(asset_type, data) {
      var _this = this;
      return this.v1meta.get_asset_class(asset_type, function(err, AssetClass) {
        var new_asset;
        new_asset = new AssetClass(void 0, _this);
        new_asset.pending(data);
        return _this.add_to_dirty(new_asset);
      });
    };

    V1Transaction.prototype.iter = function(callback) {
      var asset, _i, _len, _ref, _results;
      _ref = this.query_results;
      _results = [];
      for (_i = 0, _len = _ref.length; _i < _len; _i++) {
        asset = _ref[_i];
        _results.push(callback(asset));
      }
      return _results;
    };

    V1Transaction.prototype.commit = function(callback) {
      var dirty_asset, _i, _len, _ref, _results,
        _this = this;
      _ref = this.dirty_assets;
      _results = [];
      for (_i = 0, _len = _ref.length; _i < _len; _i++) {
        dirty_asset = _ref[_i];
        _results.push(this.v1meta.update_asset(dirty_asset, function(err, update_result) {
          return callback(err, dirty_asset, update_result);
        }));
      }
      return _results;
    };

    return V1Transaction;

  })();

  module.exports = {
    V1Meta: V1Meta = (function() {

      function V1Meta(server) {
        this.server = server;
        this.get_asset_class = __bind(this.get_asset_class, this);

        this.global_cache = {};
      }

      V1Meta.prototype.for_all_types = function(callback) {
        var _this = this;
        return this.server.get_meta_xml({
          asset_type_name: ''
        }, function(err, meta_xml) {
          if (!(err != null)) {
            return meta_xml.iter('AssetType', function(asset_xml) {
              return callback(_this.build_asset_class_from_xml(asset_xml));
            });
          }
        });
      };

      V1Meta.prototype.build_asset_class_from_xml = function(xml) {
        var asset_type_name, modelClass, v1meta,
          _this = this;
        asset_type_name = xml.get('name');
        v1meta = this;
        modelClass = (function(_super) {

          __extends(_Class, _super);

          function _Class() {
            return _Class.__super__.constructor.apply(this, arguments);
          }

          _Class.prototype._v1_asset_type_name = asset_type_name;

          _Class.prototype._v1_v1meta = v1meta;

          _Class.prototype._v1_ops = [];

          _Class.prototype._v1_attrs = [];

          return _Class;

        })(AssetClassBase);
        xml.iter('Operation', function(operation) {
          var opname;
          opname = operation.get('name');
          modelClass.prototype._v1_ops.push(opname);
          return modelClass.prototype[opname] = function() {
            return _this._v1_execute_operation(opname);
          };
        });
        xml.iter('AttributeDefinition', function(attribute) {
          var attr, getter, setter;
          attr = attribute.get('name');
          modelClass.prototype._v1_attrs.push(attr);
          if (attribute.get('attributetype') === 'Relation') {
            setter = function(value) {
              return this._v1_set(attr, value);
            };
            getter = function() {
              return _this._v1_get(attr);
            };
          }
          if (attribute.get('ismultivalue') !== 'True') {
            setter = function(value) {
              return this._v1_set(attr, value);
            };
            getter = function() {
              return this._v1_get(attr);
            };
          }
          return Object.defineProperty(modelClass.prototype, attr, {
            get: getter,
            set: setter,
            enumerable: true
          });
        });
        return modelClass;
      };

      V1Meta.prototype.build_asset = function(AssetClass, assetxml, trans) {
        var asset, attrname, attrxml, oidtoken, rel, relname, relxml, _base, _i, _j, _k, _len, _len1, _len2, _ref, _ref1, _ref2, _ref3;
        oidtoken = assetxml.get('id');
        asset = new AssetClass(oidtoken, trans);
        _ref = assetxml.findall('Attribute');
        for (_i = 0, _len = _ref.length; _i < _len; _i++) {
          attrxml = _ref[_i];
          attrname = attrxml.get('name').replace(".", "_");
          asset._v1_current_data[attrname] = attrxml.text;
        }
        _ref1 = assetxml.findall('Relation');
        for (_j = 0, _len1 = _ref1.length; _j < _len1; _j++) {
          relxml = _ref1[_j];
          relname = relxml.get('name').replace(".", "_");
          if ((_ref2 = (_base = asset._v1_current_data)[relname]) == null) {
            _base[relname] = [];
          }
          _ref3 = relxml.findall("Asset");
          for (_k = 0, _len2 = _ref3.length; _k < _len2; _k++) {
            rel = _ref3[_k];
            asset._v1_current_data[relname].push(rel.get('idref'));
          }
        }
        return asset;
      };

      V1Meta.prototype.query = function(asset_type_name, options) {
        var _this = this;
        this.validateOptions(options);
        options.asset_type_name = asset_type_name;
        return this.get_asset_class(options.asset_type_name, function(err, Cls) {
          if (err != null) {
            return options.error(err);
          }
          return _this.server.get_query_xml(options, function(err, xmlresults) {
            var asset, assetxml, _i, _len, _ref, _results;
            if (err != null) {
              options.error(err);
            }
            _ref = xmlresults.findall('.Asset');
            _results = [];
            for (_i = 0, _len = _ref.length; _i < _len; _i++) {
              assetxml = _ref[_i];
              asset = _this.build_asset(Cls, assetxml);
              _results.push(options.success(asset));
            }
            return _results;
          });
        });
      };

      V1Meta.prototype.trans_query = function(asset_type_name, options) {
        var _this = this;
        this.validateOptions(options);
        options.asset_type_name = asset_type_name;
        return this.get_asset_class(options.asset_type_name, function(err, Cls) {
          if (err != null) {
            return options.error(err);
          }
          return _this.server.get_query_xml(options, function(err, xmlresults) {
            var asset, assets, trans;
            if (err != null) {
              return options.error(err);
            }
            trans = new V1Transaction([], _this);
            assets = (function() {
              var _i, _len, _ref, _results;
              _ref = xmlresults.findall('.Asset');
              _results = [];
              for (_i = 0, _len = _ref.length; _i < _len; _i++) {
                asset = _ref[_i];
                _results.push(this.build_asset(Cls, asset, trans));
              }
              return _results;
            }).call(_this);
            trans.query_results = assets;
            return options.success(trans);
          });
        });
      };

      V1Meta.prototype.get_asset_class = function(asset_type_name, callback) {
        var _this = this;
        if (asset_type_name in this.global_cache) {
          return callback(void 0, this.global_cache[asset_type_name]);
        } else {
          return this.server.get_meta_xml({
            asset_type_name: asset_type_name
          }, function(error, xml) {
            var cls;
            if (error != null) {
              return callback(error);
            }
            cls = _this.build_asset_class_from_xml(xml);
            _this.global_cache[asset_type_name] = cls;
            return callback(void 0, cls);
          });
        }
      };

      V1Meta.prototype.validateOptions = function(options) {
        if (!(options.success != null)) {
          throw "Must pass a 'success' function callback which gets called if data retrieval succeeds";
        }
        if (!(options.error != null)) {
          throw "Must pass an 'error' function callback which gets called if data retrieval fails";
        }
      };

      return V1Meta;

    })()
  };

}).call(this);

});

require.define("/client.coffee",function(require,module,exports,__dirname,__filename,process,global){(function() {
  var V1Server, atob, browserAjaxRequest, btoa, et, querystring, url;

  et = require('elementtree');

  url = require('url');

  querystring = require('querystring');

  if (typeof btoa === "undefined") {
    btoa = function(str) {
      var b0, b1, b2, buf, c, chars, encoded, i0, i1, i2, i3;
      chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
      encoded = [];
      c = 0;
      while (c < str.length) {
        b0 = str.charCodeAt(c++);
        b1 = str.charCodeAt(c++);
        b2 = str.charCodeAt(c++);
        buf = (b0 << 16) + ((b1 || 0) << 8) + (b2 || 0);
        i0 = (buf & (63 << 18)) >> 18;
        i1 = (buf & (63 << 12)) >> 12;
        i2 = (isNaN(b1) ? 64 : (buf & (63 << 6)) >> 6);
        i3 = (isNaN(b2) ? 64 : buf & 63);
        encoded[encoded.length] = chars.charAt(i0);
        encoded[encoded.length] = chars.charAt(i1);
        encoded[encoded.length] = chars.charAt(i2);
        encoded[encoded.length] = chars.charAt(i3);
      }
      return encoded.join("");
    };
  }

  if (typeof atob === "undefined") {
    atob = function(str) {
      var b0, b1, b2, buf, c, chars, decoded, i0, i1, i2, i3, invalid;
      chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
      invalid = {
        strlen: str.length % 4 !== 0,
        chars: new RegExp("[^" + chars + "]").test(str),
        equals: RegExp("=").test(str) && (RegExp("=[^=]").test(str) || RegExp("={3}").test(str))
      };
      if (invalid.strlen || invalid.chars || invalid.equals) {
        throw new Error("Invalid base64 data");
      }
      decoded = [];
      c = 0;
      while (c < str.length) {
        i0 = chars.indexOf(str.charAt(c++));
        i1 = chars.indexOf(str.charAt(c++));
        i2 = chars.indexOf(str.charAt(c++));
        i3 = chars.indexOf(str.charAt(c++));
        buf = (i0 << 18) + (i1 << 12) + ((i2 & 63) << 6) + (i3 & 63);
        b0 = (buf & (255 << 16)) >> 16;
        b1 = (i2 === 64 ? -1 : (buf & (255 << 8)) >> 8);
        b2 = (i3 === 64 ? -1 : buf & 255);
        decoded[decoded.length] = String.fromCharCode(b0);
        if (b1 >= 0) {
          decoded[decoded.length] = String.fromCharCode(b1);
        }
        if (b2 >= 0) {
          decoded[decoded.length] = String.fromCharCode(b2);
        }
      }
      return decoded.join("");
    };
  }

  browserAjaxRequest = function(method, path, auth, errorCallback, callback) {
    var req;
    if (typeof this.XMLHttpRequest === "undefined") {
      this.XMLHttpRequest = function() {
        try {
          return new ActiveXObject("Msxml2.XMLHTTP.6.0");
        } catch (error) {

        }
        try {
          return new ActiveXObject("Msxml2.XMLHTTP.3.0");
        } catch (error) {

        }
        try {
          return new ActiveXObject("Microsoft.XMLHTTP");
        } catch (error) {
          throw new Error("This browser does not support XMLHttpRequest.");
        }
      };
    }
    req = new this.XMLHttpRequest(method, path);
    req.addEventListener('readystatechange', function() {
      if (req.readyState === 4) {
        if (req.status === 200 || req.status === 304) {
          return callback(req.responseText);
        } else {
          return errorCallback('Error loading data. Request.readyState = ' + req.readyState);
        }
      }
    });
    return function() {
      req.open(method, path, false);
      req.setRequestHeader("Authorization", "Basic " + btoa(auth));
      return req.send();
    };
  };

  module.exports = {
    V1Server: V1Server = (function() {

      function V1Server(protocol, hostname, instance, username, password, port, useBrowserHttpStack) {
        this.protocol = protocol != null ? protocol : 'http';
        this.hostname = hostname != null ? hostname : 'www14.v1host.com';
        this.instance = instance != null ? instance : 'v1sdktesting';
        this.username = username != null ? username : 'remote';
        this.password = password != null ? password : 'remote';
        this.port = port != null ? port : 80;
        this.useBrowserHttpStack = useBrowserHttpStack != null ? useBrowserHttpStack : null;
        if (this.protocol === "https" && this.port === 80) {
          this.port = 443;
        }
        return this;
      }

      V1Server.prototype.build_url = function(path, query) {
        if (query == null) {
          query = void 0;
        }
        url = '/' + this.instance + path;
        if (query != null) {
          url = url + '?' + querystring.stringify(query);
        }
        return url;
      };

      V1Server.prototype.fetch = function(options, callback) {
        var http, https;
        if (!(this.useBrowserHttpStack != null)) {
          this.useBrowserHttpStack = typeof XMLHttpRequest !== "undefined";
        }
        if (this.useBrowserHttpStack) {
          return this.fetch_browser(options, callback);
        } else {
          if (!(this.httplib != null)) {
            http = require('http');
            https = require('https');
            this.httplib = {
              http: http,
              https: https
            }[this.protocol];
          }
          return this.fetch_node(options, callback);
        }
      };

      V1Server.prototype.fetch_browser = function(options, callback) {
        var req_options, request;
        url = this.build_url(options.path, options.query);
        req_options = {
          hostname: this.hostname,
          port: this.port,
          method: (options.postdata != null ? 'POST' : 'GET'),
          path: url,
          auth: this.username + ':' + this.password
        };
        request = browserAjaxRequest(req_options.method, this.protocol + "://" + req_options.hostname + ":" + req_options.port + "/" + req_options.path, req_options.auth, options.error, function(data) {
          return callback(void 0, null, data);
        });
        return request();
      };

      V1Server.prototype.fetch_node = function(options, callback) {
        var req_options, request, request_done;
        url = this.build_url(options.path, options.query);
        req_options = {
          hostname: this.hostname,
          port: this.port,
          method: (options.postdata != null ? 'POST' : 'GET'),
          path: url,
          auth: this.username + ':' + this.password
        };
        request_done = function(response) {
          var alldata;
          alldata = [];
          response.on('data', function(data) {
            return alldata.push(data);
          });
          return response.on('end', function() {
            var body;
            body = alldata.join('');
            return callback(void 0, response, body);
          });
        };
        request = this.httplib.request(req_options, request_done);
        request.on('error', callback);
        if (options.postdata != null) {
          request.write(options.postdata);
        }
        return request.end();
      };

      V1Server.prototype.get_xml = function(options, callback) {
        var mycallback;
        mycallback = function(error, response, body) {
          var xmltree;
          if (error != null) {
            callback(error);
          }
          xmltree = et.parse(body).getroot();
          return callback(void 0, xmltree);
        };
        return this.fetch(options, mycallback);
      };

      V1Server.prototype.get_meta_xml = function(options, callback) {
        var path;
        path = '/meta.v1/' + options.asset_type_name;
        return this.get_xml({
          path: path
        }, callback);
      };

      V1Server.prototype.get_asset_xml = function(options, callback) {
        var path;
        path = '/rest-1.v1/Data/' + options.asset_type_name + '/' + options.id;
        return this.get_xml({
          path: path
        }, callback);
      };

      V1Server.prototype.get_query_xml = function(options, callback) {
        var name, path, query, value, _ref;
        path = '/rest-1.v1/Data/' + options.asset_type_name;
        query = {};
        if (options.where != null) {
          _ref = options.where;
          for (name in _ref) {
            value = _ref[name];
            query['Where'] = name + '="' + value + '"';
          }
        }
        if (options.select != null) {
          query['sel'] = options.select.join(',');
        }
        return this.get_xml({
          path: path,
          query: query
        }, callback);
      };

      V1Server.prototype.execute_operation = function(options, callback) {
        var path, query;
        path = '/rest-1.v1/Data/' + options.asset_type_name + '/' + options.id;
        query = {
          op: options.opname
        };
        return this.get_xml({
          path: path,
          query: query,
          postdata: ''
        }, callback);
      };

      V1Server.prototype.create_asset = function(options, callback) {
        var body, path, query;
        query = void 0;
        if (options.context_oid != null) {
          query = {
            ctx: options.context_oid
          };
        }
        path = '/rest-1.v1/Data/' + options.asset_type_name;
        body = et.tostring(options.xmldata);
        return this.get_xml({
          path: path,
          query: query,
          postdata: body
        }, callback);
      };

      V1Server.prototype.update_asset = function(options, callback) {
        var newdata, path;
        newdata = et.tostring(options.xmldata);
        path = '/rest-1.v1/Data/' + options.asset_type_name + '/' + options.id;
        return this.get_xml({
          path: path,
          postdata: newdata
        });
      };

      return V1Server;

    })()
  };

}).call(this);

});

require.define("/node_modules/elementtree/package.json",function(require,module,exports,__dirname,__filename,process,global){module.exports = {"main":"lib/elementtree.js"}
});

require.define("/node_modules/elementtree/lib/elementtree.js",function(require,module,exports,__dirname,__filename,process,global){/**
 *  Copyright 2011 Rackspace
 *
 *  Licensed under the Apache License, Version 2.0 (the "License");
 *  you may not use this file except in compliance with the License.
 *  You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing, software
 *  distributed under the License is distributed on an "AS IS" BASIS,
 *  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *  See the License for the specific language governing permissions and
 *  limitations under the License.
 *
 */

var sprintf = require('./sprintf').sprintf;

var utils = require('./utils');
var ElementPath = require('./elementpath');
var TreeBuilder = require('./treebuilder').TreeBuilder;
var get_parser = require('./parser').get_parser;
var constants = require('./constants');

var element_ids = 0;

function Element(tag, attrib)
{
  this._id = element_ids++;
  this.tag = tag;
  this.attrib = {};
  this.text = null;
  this.tail = null;
  this._children = [];

  if (attrib) {
    this.attrib = utils.merge(this.attrib, attrib);
  }
}

Element.prototype.toString = function()
{
  return sprintf("<Element %s at %s>", this.tag, this._id);
};

Element.prototype.makeelement = function(tag, attrib)
{
  return new Element(tag, attrib);
};

Element.prototype.len = function()
{
  return this._children.length;
};

Element.prototype.getItem = function(index)
{
  return this._children[index];
};

Element.prototype.setItem = function(index, element)
{
  this._children[index] = element;
};

Element.prototype.delItem = function(index)
{
  this._children.splice(index, 1);
};

Element.prototype.getSlice = function(start, stop)
{
  return this._children.slice(start, stop);
};

Element.prototype.setSlice = function(start, stop, elements)
{
  var i;
  var k = 0;
  for (i = start; i < stop; i++, k++) {
    this._children[i] = elements[k];
  }
};

Element.prototype.delSlice = function(start, stop)
{
  this._children.splice(start, stop - start);
};

Element.prototype.append = function(element)
{
  this._children.push(element);
};

Element.prototype.extend = function(elements)
{
  this._children.concat(elements);
};

Element.prototype.insert = function(index, element)
{
  this._children[index] = element;
};

Element.prototype.remove = function(index, element)
{
  this._children = this._children.filter(function(e) {
    /* TODO: is this the right way to do this? */
    if (e._id === element._id) {
      return false;
    }
    return true;
  });
};

Element.prototype.getchildren = function() {
  return this._children;
};

Element.prototype.find = function(path)
{
  return ElementPath.find(this, path);
};

Element.prototype.findtext = function(path, defvalue)
{
  return ElementPath.findtext(this, path, defvalue);
};

Element.prototype.findall = function(path, defvalue)
{
  return ElementPath.findall(this, path, defvalue);
};

Element.prototype.clear = function()
{
  this.attrib = {};
  this._children = [];
  this.text = null;
  this.tail = null;
};

Element.prototype.get = function(key, defvalue)
{
  if (this.attrib[key] !== undefined) {
    return this.attrib[key];
  }
  else {
    return defvalue;
  }
};

Element.prototype.set = function(key, value)
{
  this.attrib[key] = value;
};

Element.prototype.keys = function()
{
  return Object.keys(this.attrib);
};

Element.prototype.items = function()
{
  return utils.items(this.attrib);
};

/*
 * In python this uses a generator, but in v8 we don't have em,
 * so we use a callback instead.
 **/
Element.prototype.iter = function(tag, callback)
{
  var self = this;
  var i, child;

  if (tag === "*") {
    tag = null;
  }

  if (tag === null || this.tag === tag) {
    callback(self);
  }

  for (i = 0; i < this._children.length; i++) {
    child = this._children[i];
    child.iter(tag, function(e) {
      callback(e);
    });
  }
};

Element.prototype.itertext = function(callback)
{
  this.iter(null, function(e) {
    if (e.text) {
      callback(e.text);
    }

    if (e.tail) {
      callback(e.tail);
    }
  });
};


function SubElement(parent, tag, attrib) {
  var element = parent.makeelement(tag, attrib);
  parent.append(element);
  return element;
}

function Comment(text) {
  var element = new Element(Comment);
  if (text) {
    element.text = text;
  }
  return element;
}

function ProcessingInstruction(target, text)
{
  var element = new Element(ProcessingInstruction);
  element.text = target;
  if (text) {
    element.text = element.text + " " + text;
  }
  return element;
}

function QName(text_or_uri, tag)
{
  if (tag) {
    text_or_uri = sprintf("{%s}%s", text_or_uri, tag);
  }
  this.text = text_or_uri;
}

QName.prototype.toString = function() {
  return this.text;
};

function ElementTree(element)
{
  this._root = element;
}

ElementTree.prototype.getroot = function() {
  return this._root;
};

ElementTree.prototype._setroot = function(element) {
  this._root = element;
};

ElementTree.prototype.parse = function(source, parser) {
  if (!parser) {
    parser = get_parser(constants.DEFAULT_PARSER);
    parser = new parser.XMLParser(new TreeBuilder());
  }

  parser.feed(source);
  this._root = parser.close();
  return this._root;
};

ElementTree.prototype.iter = function(tag, callback) {
  this._root.iter(tag, callback);
};

ElementTree.prototype.find = function(path) {
  return this._root.find(path);
};

ElementTree.prototype.findtext = function(path, defvalue) {
  return this._root.findtext(path, defvalue);
};

ElementTree.prototype.findall = function(path) {
  return this._root.findall(path);
};

/**
 * Unlike ElementTree, we don't write to a file, we return you a string.
 */
ElementTree.prototype.write = function(options) {
  var sb = [];
  options = utils.merge({
    encoding: 'utf-8',
    xml_declaration: null,
    default_namespace: null,
    method: 'xml'}, options);

  if (options.xml_declaration !== false) {
    sb.push("<?xml version='1.0' encoding='"+options.encoding +"'?>\n");
  }

  if (options.method === "text") {
    _serialize_text(sb, self._root, encoding);
  }
  else {
    var qnames, namespaces, indent, indent_string;
    var x = _namespaces(this._root, options.encoding, options.default_namespace);
    qnames = x[0];
    namespaces = x[1];

    if (options.hasOwnProperty('indent')) {
      indent = 0;
      indent_string = new Array(options.indent + 1).join(' ');
    }
    else {
      indent = false;
    }

    if (options.method === "xml") {
      _serialize_xml(function(data) {
        sb.push(data);
      }, this._root, options.encoding, qnames, namespaces, indent, indent_string);
    }
    else {
      /* TODO: html */
      throw new Error("unknown serialization method "+ options.method);
    }
  }

  return sb.join("");
};

var _namespace_map = {
    /* "well-known" namespace prefixes */
    "http://www.w3.org/XML/1998/namespace": "xml",
    "http://www.w3.org/1999/xhtml": "html",
    "http://www.w3.org/1999/02/22-rdf-syntax-ns#": "rdf",
    "http://schemas.xmlsoap.org/wsdl/": "wsdl",
    /* xml schema */
    "http://www.w3.org/2001/XMLSchema": "xs",
    "http://www.w3.org/2001/XMLSchema-instance": "xsi",
    /* dublic core */
    "http://purl.org/dc/elements/1.1/": "dc",
};

function register_namespace(prefix, uri) {
  if (/ns\d+$/.test(prefix)) {
    throw new Error('Prefix format reserved for internal use');
  }

  if (_namespace_map.hasOwnProperty(uri) && _namespace_map[uri] === prefix) {
    delete _namespace_map[uri];
  }

  _namespace_map[uri] = prefix;
}


function _escape(text, encoding, isAttribute, isText) {
  if (text) {
    text = text.toString();
    text = text.replace(/&/g, '&amp;');
    text = text.replace(/</g, '&lt;');
    text = text.replace(/>/g, '&gt;');
    if (!isText) {
        text = text.replace(/\n/g, '&#xA;');
        text = text.replace(/\r/g, '&#xD;');
    }
    if (isAttribute) {
      text = text.replace(/"/g, '&quot;');
    }
  }
  return text;
}

/* TODO: benchmark single regex */
function _escape_attrib(text, encoding) {
  return _escape(text, encoding, true);
}

function _escape_cdata(text, encoding) {
  return _escape(text, encoding, false);
}

function _escape_text(text, encoding) {
  return _escape(text, encoding, false, true);
}

function _namespaces(elem, encoding, default_namespace) {
  var qnames = {};
  var namespaces = {};

  if (default_namespace) {
    namespaces[default_namespace] = "";
  }

  function encode(text) {
    return text;
  }

  function add_qname(qname) {
    if (qname[0] === "{") {
      var tmp = qname.substring(1).split("}", 2);
      var uri = tmp[0];
      var tag = tmp[1];
      var prefix = namespaces[uri];

      if (prefix === undefined) {
        prefix = _namespace_map[uri];
        if (prefix === undefined) {
          prefix = "ns" + Object.keys(namespaces).length;
        }
        if (prefix !== "xml") {
          namespaces[uri] = prefix;
        }
      }

      if (prefix) {
        qnames[qname] = sprintf("%s:%s", prefix, tag);
      }
      else {
        qnames[qname] = tag;
      }
    }
    else {
      if (default_namespace) {
        throw new Error('cannot use non-qualified names with default_namespace option');
      }

      qnames[qname] = qname;
    }
  }


  elem.iter(null, function(e) {
    var i;
    var tag = e.tag;
    var text = e.text;
    var items = e.items();

    if (tag instanceof QName && qnames[tag.text] === undefined) {
      add_qname(tag.text);
    }
    else if (typeof(tag) === "string") {
      add_qname(tag);
    }
    else if (tag !== null && tag !== Comment && tag !== ProcessingInstruction) {
      throw new Error('Invalid tag type for serialization: '+ tag);
    }

    if (text instanceof QName && qnames[text.text] === undefined) {
      add_qname(text.text);
    }

    items.forEach(function(item) {
      var key = item[0],
          value = item[1];
      if (key instanceof QName) {
        key = key.text;
      }

      if (qnames[key] === undefined) {
        add_qname(key);
      }

      if (value instanceof QName && qnames[value.text] === undefined) {
        add_qname(value.text);
      }
    });
  });
  return [qnames, namespaces];
}

function _serialize_xml(write, elem, encoding, qnames, namespaces, indent, indent_string) {
  var tag = elem.tag;
  var text = elem.text;
  var items;
  var i;

  var newlines = indent || (indent === 0);
  write(Array(indent + 1).join(indent_string));

  if (tag === Comment) {
    write(sprintf("<!--%s-->", _escape_cdata(text, encoding)));
  }
  else if (tag === ProcessingInstruction) {
    write(sprintf("<?%s?>", _escape_cdata(text, encoding)));
  }
  else {
    tag = qnames[tag];
    if (tag === undefined) {
      if (text) {
        write(_escape_text(text, encoding));
      }
      elem.iter(function(e) {
        _serialize_xml(write, e, encoding, qnames, null, newlines ? indent + 1 : false, indent_string);
      });
    }
    else {
      write("<" + tag);
      items = elem.items();

      if (items || namespaces) {
        items.sort(); // lexical order

        items.forEach(function(item) {
          var k = item[0],
              v = item[1];

            if (k instanceof QName) {
              k = k.text;
            }

            if (v instanceof QName) {
              v = qnames[v.text];
            }
            else {
              v = _escape_attrib(v, encoding);
            }
            write(sprintf(" %s=\"%s\"", qnames[k], v));
        });

        if (namespaces) {
          items = utils.items(namespaces);
          items.sort(function(a, b) { return a[1] < b[1]; });

          items.forEach(function(item) {
            var k = item[1],
                v = item[0];

            if (k) {
              k = ':' + k;
            }

            write(sprintf(" xmlns%s=\"%s\"", k, _escape_attrib(v, encoding)));
          });
        }
      }

      if (text || elem.len()) {
        if (text && text.toString().match(/^\s*$/)) {
            text = null;
        }

        write(">");
        if (!text && newlines) {
          write("\n");
        }

        if (text) {
          write(_escape_text(text, encoding));
        }
        elem._children.forEach(function(e) {
          _serialize_xml(write, e, encoding, qnames, null, newlines ? indent + 1 : false, indent_string);
        });

        if (!text && indent) {
          write(Array(indent + 1).join(indent_string));
        }
        write("</" + tag + ">");
      }
      else {
        write(" />");
      }
    }
  }

  if (newlines) {
    write("\n");
  }
}

function parse(source, parser) {
  var tree = new ElementTree();
  tree.parse(source, parser);
  return tree;
}

function tostring(element, options) {
  return new ElementTree(element).write(options);
}

exports.PI = ProcessingInstruction;
exports.Comment = Comment;
exports.ProcessingInstruction = ProcessingInstruction;
exports.SubElement = SubElement;
exports.QName = QName;
exports.ElementTree = ElementTree;
exports.ElementPath = ElementPath;
exports.Element = function(tag, attrib) {
  return new Element(tag, attrib);
};

exports.XML = function(data) {
  var et = new ElementTree();
  return et.parse(data);
};

exports.parse = parse;
exports.register_namespace = register_namespace;
exports.tostring = tostring;

});

require.define("/node_modules/elementtree/lib/sprintf.js",function(require,module,exports,__dirname,__filename,process,global){/*
 *  Copyright 2011 Rackspace
 *
 *  Licensed under the Apache License, Version 2.0 (the "License");
 *  you may not use this file except in compliance with the License.
 *  You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing, software
 *  distributed under the License is distributed on an "AS IS" BASIS,
 *  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *  See the License for the specific language governing permissions and
 *  limitations under the License.
 *
 */

var cache = {};


// Do any others need escaping?
var TO_ESCAPE = {
  '\'': '\\\'',
  '\n': '\\n'
};


function populate(formatter) {
  var i, type,
      key = formatter,
      prev = 0,
      arg = 1,
      builder = 'return \'';

  for (i = 0; i < formatter.length; i++) {
    if (formatter[i] === '%') {
      type = formatter[i + 1];

      switch (type) {
        case 's':
          builder += formatter.slice(prev, i) + '\' + arguments[' + arg + '] + \'';
          prev = i + 2;
          arg++;
          break;
        case 'j':
          builder += formatter.slice(prev, i) + '\' + JSON.stringify(arguments[' + arg + ']) + \'';
          prev = i + 2;
          arg++;
          break;
        case '%':
          builder += formatter.slice(prev, i + 1);
          prev = i + 2;
          i++;
          break;
      }


    } else if (TO_ESCAPE[formatter[i]]) {
      builder += formatter.slice(prev, i) + TO_ESCAPE[formatter[i]];
      prev = i + 1;
    }
  }

  builder += formatter.slice(prev) + '\';';
  cache[key] = new Function(builder);
}


/**
 * A fast version of sprintf(), which currently only supports the %s and %j.
 * This caches a formatting function for each format string that is used, so
 * you should only use this sprintf() will be called many times with a single
 * format string and a limited number of format strings will ever be used (in
 * general this means that format strings should be string literals).
 *
 * @param {String} formatter A format string.
 * @param {...String} var_args Values that will be formatted by %s and %j.
 * @return {String} The formatted output.
 */
exports.sprintf = function(formatter, var_args) {
  if (!cache[formatter]) {
    populate(formatter);
  }

  return cache[formatter].apply(null, arguments);
};

});

require.define("/node_modules/elementtree/lib/utils.js",function(require,module,exports,__dirname,__filename,process,global){/**
 *  Copyright 2011 Rackspace
 *
 *  Licensed under the Apache License, Version 2.0 (the "License");
 *  you may not use this file except in compliance with the License.
 *  You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing, software
 *  distributed under the License is distributed on an "AS IS" BASIS,
 *  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *  See the License for the specific language governing permissions and
 *  limitations under the License.
 *
 */

/**
 * @param {Object} hash.
 * @param {Array} ignored.
 */
function items(hash, ignored) {
  ignored = ignored || null;
  var k, rv = [];

  function is_ignored(key) {
    if (!ignored || ignored.length === 0) {
      return false;
    }

    return ignored.indexOf(key);
  }

  for (k in hash) {
    if (hash.hasOwnProperty(k) && !(is_ignored(ignored))) {
      rv.push([k, hash[k]]);
    }
  }

  return rv;
}


function findall(re, str) {
  var match, matches = [];

  while ((match = re.exec(str))) {
      matches.push(match);
  }

  return matches;
}

function merge(a, b) {
  var c = {}, attrname;

  for (attrname in a) {
    if (a.hasOwnProperty(attrname)) {
      c[attrname] = a[attrname];
    }
  }
  for (attrname in b) {
    if (b.hasOwnProperty(attrname)) {
      c[attrname] = b[attrname];
    }
  }
  return c;
}

exports.items = items;
exports.findall = findall;
exports.merge = merge;

});

require.define("/node_modules/elementtree/lib/elementpath.js",function(require,module,exports,__dirname,__filename,process,global){/**
 *  Copyright 2011 Rackspace
 *
 *  Licensed under the Apache License, Version 2.0 (the "License");
 *  you may not use this file except in compliance with the License.
 *  You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing, software
 *  distributed under the License is distributed on an "AS IS" BASIS,
 *  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *  See the License for the specific language governing permissions and
 *  limitations under the License.
 *
 */

var sprintf = require('./sprintf').sprintf;

var utils = require('./utils');
var SyntaxError = require('./errors').SyntaxError;

var _cache = {};

var RE = new RegExp(
  "(" +
  "'[^']*'|\"[^\"]*\"|" +
  "::|" +
  "//?|" +
  "\\.\\.|" +
  "\\(\\)|" +
  "[/.*:\\[\\]\\(\\)@=])|" +
  "((?:\\{[^}]+\\})?[^/:\\[\\]\\(\\)@=\\s]+)|" +
  "\\s+", 'g'
);

var xpath_tokenizer = utils.findall.bind(null, RE);

function prepare_tag(next, token) {
  var tag = token[0];

  function select(context, result) {
    var i, len, elem, rv = [];

    for (i = 0, len = result.length; i < len; i++) {
      elem = result[i];
      elem._children.forEach(function(e) {
        if (e.tag === tag) {
          rv.push(e);
        }
      });
    }

    return rv;
  }

  return select;
}

function prepare_star(next, token) {
  function select(context, result) {
    var i, len, elem, rv = [];

    for (i = 0, len = result.length; i < len; i++) {
      elem = result[i];
      elem._children.forEach(function(e) {
        rv.push(e);
      });
    }

    return rv;
  }

  return select;
}

function prepare_dot(next, token) {
  function select(context, result) {
    var i, len, elem, rv = [];

    for (i = 0, len = result.length; i < len; i++) {
      elem = result[i];
      rv.push(elem);
    }

    return rv;
  }

  return select;
}

function prepare_iter(next, token) {
  var tag;
  token = next();

  if (token[1] === '*') {
    tag = '*';
  }
  else if (!token[1]) {
    tag = token[0] || '';
  }
  else {
    throw new SyntaxError(token);
  }

  function select(context, result) {
    var i, len, elem, rv = [];

    for (i = 0, len = result.length; i < len; i++) {
      elem = result[i];
      elem.iter(tag, function(e) {
        if (e !== elem) {
          rv.push(e);
        }
      });
    }

    return rv;
  }

  return select;
}

function prepare_dot_dot(next, token) {
  function select(context, result) {
    var i, len, elem, rv = [], parent_map = context.parent_map;

    if (!parent_map) {
      context.parent_map = parent_map = {};

      context.root.iter(null, function(p) {
        p._children.forEach(function(e) {
          parent_map[e] = p;
        });
      });
    }

    for (i = 0, len = result.length; i < len; i++) {
      elem = result[i];

      if (parent_map.hasOwnProperty(elem)) {
        rv.push(parent_map[elem]);
      }
    }

    return rv;
  }

  return select;
}


function prepare_predicate(next, token) {
  var tag, key, value, select;
  token = next();

  if (token[1] === '@') {
    // attribute
    token = next();

    if (token[1]) {
      throw new SyntaxError(token, 'Invalid attribute predicate');
    }

    key = token[0];
    token = next();

    if (token[1] === ']') {
      select = function(context, result) {
        var i, len, elem, rv = [];

        for (i = 0, len = result.length; i < len; i++) {
          elem = result[i];

          if (elem.get(key)) {
            rv.push(elem);
          }
        }

        return rv;
      };
    }
    else if (token[1] === '=') {
      value = next()[1];

      if (value[0] === '"' || value[value.length - 1] === '\'') {
        value = value.slice(1, value.length - 1);
      }
      else {
        throw new SyntaxError(token, 'Ivalid comparison target');
      }

      token = next();
      select = function(context, result) {
        var i, len, elem, rv = [];

        for (i = 0, len = result.length; i < len; i++) {
          elem = result[i];

          if (elem.get(key) === value) {
            rv.push(elem);
          }
        }

        return rv;
      };
    }

    if (token[1] !== ']') {
      throw new SyntaxError(token, 'Invalid attribute predicate');
    }
  }
  else if (!token[1]) {
    tag = token[0] || '';
    token = next();

    if (token[1] !== ']') {
      throw new SyntaxError(token, 'Invalid node predicate');
    }

    select = function(context, result) {
      var i, len, elem, rv = [];

      for (i = 0, len = result.length; i < len; i++) {
        elem = result[i];

        if (elem.find(tag)) {
          rv.push(elem);
        }
      }

      return rv;
    };
  }
  else {
    throw new SyntaxError(null, 'Invalid predicate');
  }

  return select;
}



var ops = {
  "": prepare_tag,
  "*": prepare_star,
  ".": prepare_dot,
  "..": prepare_dot_dot,
  "//": prepare_iter,
  "[": prepare_predicate,
};

function _SelectorContext(root) {
  this.parent_map = null;
  this.root = root;
}

function findall(elem, path) {
  var selector, result, i, len, token, value, select, context;

  if (_cache.hasOwnProperty(path)) {
    selector = _cache[path];
  }
  else {
    // TODO: Use smarter cache purging approach
    if (Object.keys(_cache).length > 100) {
      _cache = {};
    }

    if (path.charAt(0) === '/') {
      throw new SyntaxError(null, 'Cannot use absolute path on element');
    }

    result = xpath_tokenizer(path);
    selector = [];

    function getToken() {
      return result.shift();
    }

    token = getToken();
    while (true) {
      var c = token[1] || '';
      value = ops[c](getToken, token);

      if (!value) {
        throw new SyntaxError(null, sprintf('Invalid path: %s', path));
      }

      selector.push(value);
      token = getToken();

      if (!token) {
        break;
      }
      else if (token[1] === '/') {
        token = getToken();
      }

      if (!token) {
        break;
      }
    }

    _cache[path] = selector;
  }

  // Execute slector pattern
  result = [elem];
  context = new _SelectorContext(elem);

  for (i = 0, len = selector.length; i < len; i++) {
    select = selector[i];
    result = select(context, result);
  }

  return result || [];
}

function find(element, path) {
  var resultElement = findall(element, path);

  if (resultElement) {
    return resultElement[0];
  }

  return null;
}

function findtext(element, path, defvalue) {
  var resultElements = findall(element, path);

  if (resultElements) {
    return resultElements[0].text;
  }

  return defvalue;
}


exports.find = find;
exports.findall = findall;
exports.findtext = findtext;

});

require.define("/node_modules/elementtree/lib/errors.js",function(require,module,exports,__dirname,__filename,process,global){/**
 *  Copyright 2011 Rackspace
 *
 *  Licensed under the Apache License, Version 2.0 (the "License");
 *  you may not use this file except in compliance with the License.
 *  You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing, software
 *  distributed under the License is distributed on an "AS IS" BASIS,
 *  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *  See the License for the specific language governing permissions and
 *  limitations under the License.
 *
 */

var util = require('util');

var sprintf = require('./sprintf').sprintf;

function SyntaxError(token, msg) {
  msg = msg || sprintf('Syntax Error at token %s', token.toString());
  this.token = token;
  this.message = msg;
  Error.call(this, msg);
}

util.inherits(SyntaxError, Error);

exports.SyntaxError = SyntaxError;

});

require.define("util",function(require,module,exports,__dirname,__filename,process,global){var events = require('events');

exports.print = function () {};
exports.puts = function () {};
exports.debug = function() {};

exports.inspect = function(obj, showHidden, depth, colors) {
  var seen = [];

  var stylize = function(str, styleType) {
    // http://en.wikipedia.org/wiki/ANSI_escape_code#graphics
    var styles =
        { 'bold' : [1, 22],
          'italic' : [3, 23],
          'underline' : [4, 24],
          'inverse' : [7, 27],
          'white' : [37, 39],
          'grey' : [90, 39],
          'black' : [30, 39],
          'blue' : [34, 39],
          'cyan' : [36, 39],
          'green' : [32, 39],
          'magenta' : [35, 39],
          'red' : [31, 39],
          'yellow' : [33, 39] };

    var style =
        { 'special': 'cyan',
          'number': 'blue',
          'boolean': 'yellow',
          'undefined': 'grey',
          'null': 'bold',
          'string': 'green',
          'date': 'magenta',
          // "name": intentionally not styling
          'regexp': 'red' }[styleType];

    if (style) {
      return '\033[' + styles[style][0] + 'm' + str +
             '\033[' + styles[style][1] + 'm';
    } else {
      return str;
    }
  };
  if (! colors) {
    stylize = function(str, styleType) { return str; };
  }

  function format(value, recurseTimes) {
    // Provide a hook for user-specified inspect functions.
    // Check that value is an object with an inspect function on it
    if (value && typeof value.inspect === 'function' &&
        // Filter out the util module, it's inspect function is special
        value !== exports &&
        // Also filter out any prototype objects using the circular check.
        !(value.constructor && value.constructor.prototype === value)) {
      return value.inspect(recurseTimes);
    }

    // Primitive types cannot have properties
    switch (typeof value) {
      case 'undefined':
        return stylize('undefined', 'undefined');

      case 'string':
        var simple = '\'' + JSON.stringify(value).replace(/^"|"$/g, '')
                                                 .replace(/'/g, "\\'")
                                                 .replace(/\\"/g, '"') + '\'';
        return stylize(simple, 'string');

      case 'number':
        return stylize('' + value, 'number');

      case 'boolean':
        return stylize('' + value, 'boolean');
    }
    // For some reason typeof null is "object", so special case here.
    if (value === null) {
      return stylize('null', 'null');
    }

    // Look up the keys of the object.
    var visible_keys = Object_keys(value);
    var keys = showHidden ? Object_getOwnPropertyNames(value) : visible_keys;

    // Functions without properties can be shortcutted.
    if (typeof value === 'function' && keys.length === 0) {
      if (isRegExp(value)) {
        return stylize('' + value, 'regexp');
      } else {
        var name = value.name ? ': ' + value.name : '';
        return stylize('[Function' + name + ']', 'special');
      }
    }

    // Dates without properties can be shortcutted
    if (isDate(value) && keys.length === 0) {
      return stylize(value.toUTCString(), 'date');
    }

    var base, type, braces;
    // Determine the object type
    if (isArray(value)) {
      type = 'Array';
      braces = ['[', ']'];
    } else {
      type = 'Object';
      braces = ['{', '}'];
    }

    // Make functions say that they are functions
    if (typeof value === 'function') {
      var n = value.name ? ': ' + value.name : '';
      base = (isRegExp(value)) ? ' ' + value : ' [Function' + n + ']';
    } else {
      base = '';
    }

    // Make dates with properties first say the date
    if (isDate(value)) {
      base = ' ' + value.toUTCString();
    }

    if (keys.length === 0) {
      return braces[0] + base + braces[1];
    }

    if (recurseTimes < 0) {
      if (isRegExp(value)) {
        return stylize('' + value, 'regexp');
      } else {
        return stylize('[Object]', 'special');
      }
    }

    seen.push(value);

    var output = keys.map(function(key) {
      var name, str;
      if (value.__lookupGetter__) {
        if (value.__lookupGetter__(key)) {
          if (value.__lookupSetter__(key)) {
            str = stylize('[Getter/Setter]', 'special');
          } else {
            str = stylize('[Getter]', 'special');
          }
        } else {
          if (value.__lookupSetter__(key)) {
            str = stylize('[Setter]', 'special');
          }
        }
      }
      if (visible_keys.indexOf(key) < 0) {
        name = '[' + key + ']';
      }
      if (!str) {
        if (seen.indexOf(value[key]) < 0) {
          if (recurseTimes === null) {
            str = format(value[key]);
          } else {
            str = format(value[key], recurseTimes - 1);
          }
          if (str.indexOf('\n') > -1) {
            if (isArray(value)) {
              str = str.split('\n').map(function(line) {
                return '  ' + line;
              }).join('\n').substr(2);
            } else {
              str = '\n' + str.split('\n').map(function(line) {
                return '   ' + line;
              }).join('\n');
            }
          }
        } else {
          str = stylize('[Circular]', 'special');
        }
      }
      if (typeof name === 'undefined') {
        if (type === 'Array' && key.match(/^\d+$/)) {
          return str;
        }
        name = JSON.stringify('' + key);
        if (name.match(/^"([a-zA-Z_][a-zA-Z_0-9]*)"$/)) {
          name = name.substr(1, name.length - 2);
          name = stylize(name, 'name');
        } else {
          name = name.replace(/'/g, "\\'")
                     .replace(/\\"/g, '"')
                     .replace(/(^"|"$)/g, "'");
          name = stylize(name, 'string');
        }
      }

      return name + ': ' + str;
    });

    seen.pop();

    var numLinesEst = 0;
    var length = output.reduce(function(prev, cur) {
      numLinesEst++;
      if (cur.indexOf('\n') >= 0) numLinesEst++;
      return prev + cur.length + 1;
    }, 0);

    if (length > 50) {
      output = braces[0] +
               (base === '' ? '' : base + '\n ') +
               ' ' +
               output.join(',\n  ') +
               ' ' +
               braces[1];

    } else {
      output = braces[0] + base + ' ' + output.join(', ') + ' ' + braces[1];
    }

    return output;
  }
  return format(obj, (typeof depth === 'undefined' ? 2 : depth));
};


function isArray(ar) {
  return ar instanceof Array ||
         Array.isArray(ar) ||
         (ar && ar !== Object.prototype && isArray(ar.__proto__));
}


function isRegExp(re) {
  return re instanceof RegExp ||
    (typeof re === 'object' && Object.prototype.toString.call(re) === '[object RegExp]');
}


function isDate(d) {
  if (d instanceof Date) return true;
  if (typeof d !== 'object') return false;
  var properties = Date.prototype && Object_getOwnPropertyNames(Date.prototype);
  var proto = d.__proto__ && Object_getOwnPropertyNames(d.__proto__);
  return JSON.stringify(proto) === JSON.stringify(properties);
}

function pad(n) {
  return n < 10 ? '0' + n.toString(10) : n.toString(10);
}

var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep',
              'Oct', 'Nov', 'Dec'];

// 26 Feb 16:19:34
function timestamp() {
  var d = new Date();
  var time = [pad(d.getHours()),
              pad(d.getMinutes()),
              pad(d.getSeconds())].join(':');
  return [d.getDate(), months[d.getMonth()], time].join(' ');
}

exports.log = function (msg) {};

exports.pump = null;

var Object_keys = Object.keys || function (obj) {
    var res = [];
    for (var key in obj) res.push(key);
    return res;
};

var Object_getOwnPropertyNames = Object.getOwnPropertyNames || function (obj) {
    var res = [];
    for (var key in obj) {
        if (Object.hasOwnProperty.call(obj, key)) res.push(key);
    }
    return res;
};

var Object_create = Object.create || function (prototype, properties) {
    // from es5-shim
    var object;
    if (prototype === null) {
        object = { '__proto__' : null };
    }
    else {
        if (typeof prototype !== 'object') {
            throw new TypeError(
                'typeof prototype[' + (typeof prototype) + '] != \'object\''
            );
        }
        var Type = function () {};
        Type.prototype = prototype;
        object = new Type();
        object.__proto__ = prototype;
    }
    if (typeof properties !== 'undefined' && Object.defineProperties) {
        Object.defineProperties(object, properties);
    }
    return object;
};

exports.inherits = function(ctor, superCtor) {
  ctor.super_ = superCtor;
  ctor.prototype = Object_create(superCtor.prototype, {
    constructor: {
      value: ctor,
      enumerable: false,
      writable: true,
      configurable: true
    }
  });
};

var formatRegExp = /%[sdj%]/g;
exports.format = function(f) {
  if (typeof f !== 'string') {
    var objects = [];
    for (var i = 0; i < arguments.length; i++) {
      objects.push(exports.inspect(arguments[i]));
    }
    return objects.join(' ');
  }

  var i = 1;
  var args = arguments;
  var len = args.length;
  var str = String(f).replace(formatRegExp, function(x) {
    if (x === '%%') return '%';
    if (i >= len) return x;
    switch (x) {
      case '%s': return String(args[i++]);
      case '%d': return Number(args[i++]);
      case '%j': return JSON.stringify(args[i++]);
      default:
        return x;
    }
  });
  for(var x = args[i]; i < len; x = args[++i]){
    if (x === null || typeof x !== 'object') {
      str += ' ' + x;
    } else {
      str += ' ' + exports.inspect(x);
    }
  }
  return str;
};

});

require.define("events",function(require,module,exports,__dirname,__filename,process,global){if (!process.EventEmitter) process.EventEmitter = function () {};

var EventEmitter = exports.EventEmitter = process.EventEmitter;
var isArray = typeof Array.isArray === 'function'
    ? Array.isArray
    : function (xs) {
        return Object.prototype.toString.call(xs) === '[object Array]'
    }
;

// By default EventEmitters will print a warning if more than
// 10 listeners are added to it. This is a useful default which
// helps finding memory leaks.
//
// Obviously not all Emitters should be limited to 10. This function allows
// that to be increased. Set to zero for unlimited.
var defaultMaxListeners = 10;
EventEmitter.prototype.setMaxListeners = function(n) {
  if (!this._events) this._events = {};
  this._events.maxListeners = n;
};


EventEmitter.prototype.emit = function(type) {
  // If there is no 'error' event listener then throw.
  if (type === 'error') {
    if (!this._events || !this._events.error ||
        (isArray(this._events.error) && !this._events.error.length))
    {
      if (arguments[1] instanceof Error) {
        throw arguments[1]; // Unhandled 'error' event
      } else {
        throw new Error("Uncaught, unspecified 'error' event.");
      }
      return false;
    }
  }

  if (!this._events) return false;
  var handler = this._events[type];
  if (!handler) return false;

  if (typeof handler == 'function') {
    switch (arguments.length) {
      // fast cases
      case 1:
        handler.call(this);
        break;
      case 2:
        handler.call(this, arguments[1]);
        break;
      case 3:
        handler.call(this, arguments[1], arguments[2]);
        break;
      // slower
      default:
        var args = Array.prototype.slice.call(arguments, 1);
        handler.apply(this, args);
    }
    return true;

  } else if (isArray(handler)) {
    var args = Array.prototype.slice.call(arguments, 1);

    var listeners = handler.slice();
    for (var i = 0, l = listeners.length; i < l; i++) {
      listeners[i].apply(this, args);
    }
    return true;

  } else {
    return false;
  }
};

// EventEmitter is defined in src/node_events.cc
// EventEmitter.prototype.emit() is also defined there.
EventEmitter.prototype.addListener = function(type, listener) {
  if ('function' !== typeof listener) {
    throw new Error('addListener only takes instances of Function');
  }

  if (!this._events) this._events = {};

  // To avoid recursion in the case that type == "newListeners"! Before
  // adding it to the listeners, first emit "newListeners".
  this.emit('newListener', type, listener);

  if (!this._events[type]) {
    // Optimize the case of one listener. Don't need the extra array object.
    this._events[type] = listener;
  } else if (isArray(this._events[type])) {

    // Check for listener leak
    if (!this._events[type].warned) {
      var m;
      if (this._events.maxListeners !== undefined) {
        m = this._events.maxListeners;
      } else {
        m = defaultMaxListeners;
      }

      if (m && m > 0 && this._events[type].length > m) {
        this._events[type].warned = true;
        console.error('(node) warning: possible EventEmitter memory ' +
                      'leak detected. %d listeners added. ' +
                      'Use emitter.setMaxListeners() to increase limit.',
                      this._events[type].length);
        console.trace();
      }
    }

    // If we've already got an array, just append.
    this._events[type].push(listener);
  } else {
    // Adding the second element, need to change to array.
    this._events[type] = [this._events[type], listener];
  }

  return this;
};

EventEmitter.prototype.on = EventEmitter.prototype.addListener;

EventEmitter.prototype.once = function(type, listener) {
  var self = this;
  self.on(type, function g() {
    self.removeListener(type, g);
    listener.apply(this, arguments);
  });

  return this;
};

EventEmitter.prototype.removeListener = function(type, listener) {
  if ('function' !== typeof listener) {
    throw new Error('removeListener only takes instances of Function');
  }

  // does not use listeners(), so no side effect of creating _events[type]
  if (!this._events || !this._events[type]) return this;

  var list = this._events[type];

  if (isArray(list)) {
    var i = list.indexOf(listener);
    if (i < 0) return this;
    list.splice(i, 1);
    if (list.length == 0)
      delete this._events[type];
  } else if (this._events[type] === listener) {
    delete this._events[type];
  }

  return this;
};

EventEmitter.prototype.removeAllListeners = function(type) {
  // does not use listeners(), so no side effect of creating _events[type]
  if (type && this._events && this._events[type]) this._events[type] = null;
  return this;
};

EventEmitter.prototype.listeners = function(type) {
  if (!this._events) this._events = {};
  if (!this._events[type]) this._events[type] = [];
  if (!isArray(this._events[type])) {
    this._events[type] = [this._events[type]];
  }
  return this._events[type];
};

});

require.define("/node_modules/elementtree/lib/treebuilder.js",function(require,module,exports,__dirname,__filename,process,global){function TreeBuilder(element_factory) {
  this._data = [];
  this._elem = [];
  this._last = null;
  this._tail = null;
  if (!element_factory) {
    /* evil circular dep */
    element_factory = require('./elementtree').Element;
  }
  this._factory = element_factory;
}

TreeBuilder.prototype.close = function() {
  return this._last;
};

TreeBuilder.prototype._flush = function() {
  if (this._data) {
    if (this._last !== null) {
      var text = this._data.join("");
      if (this._tail) {
        this._last.tail = text;
      }
      else {
        this._last.text = text;
      }
    }
    this._data = [];
  }
};

TreeBuilder.prototype.data = function(data) {
  this._data.push(data);
};

TreeBuilder.prototype.start = function(tag, attrs) {
  this._flush();
  var elem = this._factory(tag, attrs);
  this._last = elem;

  if (this._elem.length) {
    this._elem[this._elem.length - 1].append(elem);
  }

  this._elem.push(elem);

  this._tail = null;
};

TreeBuilder.prototype.end = function(tag) {
  this._flush();
  this._last = this._elem.pop();
  if (this._last.tag !== tag) {
    throw new Error("end tag mismatch");
  }
  this._tail = 1;
  return this._last;
};

exports.TreeBuilder = TreeBuilder;

});

require.define("/node_modules/elementtree/lib/parser.js",function(require,module,exports,__dirname,__filename,process,global){/*
 *  Copyright 2011 Rackspace
 *
 *  Licensed under the Apache License, Version 2.0 (the "License");
 *  you may not use this file except in compliance with the License.
 *  You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing, software
 *  distributed under the License is distributed on an "AS IS" BASIS,
 *  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *  See the License for the specific language governing permissions and
 *  limitations under the License.
 *
 */

/* TODO: support node-expat C++ module optionally */

var util = require('util');
var parsers = require('./parsers/index');

function get_parser(name) {
  if (name === 'sax') {
    return parsers.sax;
  }
  else {
    throw new Error('Invalid parser: ' + name);
  }
}


exports.get_parser = get_parser;

});

require.define("/node_modules/elementtree/lib/parsers/index.js",function(require,module,exports,__dirname,__filename,process,global){exports.sax = require('./sax');

});

require.define("/node_modules/elementtree/lib/parsers/sax.js",function(require,module,exports,__dirname,__filename,process,global){var util = require('util');

var sax = require('sax');

var TreeBuilder = require('./../treebuilder').TreeBuilder;

function XMLParser(target) {
  this.parser = sax.parser(true);

  this.target = (target) ? target : new TreeBuilder();

  this.parser.onopentag = this._handleOpenTag.bind(this);
  this.parser.ontext = this._handleText.bind(this);
  this.parser.oncdata = this._handleCdata.bind(this);
  this.parser.ondoctype = this._handleDoctype.bind(this);
  this.parser.oncomment = this._handleComment.bind(this);
  this.parser.onclosetag = this._handleCloseTag.bind(this);
  this.parser.onerror = this._handleError.bind(this);
}

XMLParser.prototype._handleOpenTag = function(tag) {
  this.target.start(tag.name, tag.attributes);
};

XMLParser.prototype._handleText = function(text) {
  this.target.data(text);
};

XMLParser.prototype._handleCdata = function(text) {
  this.target.data(text);
};

XMLParser.prototype._handleDoctype = function(text) {
};

XMLParser.prototype._handleComment = function(comment) {
};

XMLParser.prototype._handleCloseTag = function(tag) {
  this.target.end(tag);
};

XMLParser.prototype._handleError = function(err) {
  throw err;
};

XMLParser.prototype.feed = function(chunk) {
  this.parser.write(chunk);
};

XMLParser.prototype.close = function() {
  this.parser.close();
  return this.target.close();
};

exports.XMLParser = XMLParser;

});

require.define("/node_modules/elementtree/node_modules/sax/package.json",function(require,module,exports,__dirname,__filename,process,global){module.exports = {"main":"lib/sax.js"}
});

require.define("/node_modules/elementtree/node_modules/sax/lib/sax.js",function(require,module,exports,__dirname,__filename,process,global){// wrapper for non-node envs
;(function (sax) {

sax.parser = function (strict, opt) { return new SAXParser(strict, opt) }
sax.SAXParser = SAXParser
sax.SAXStream = SAXStream
sax.createStream = createStream

// When we pass the MAX_BUFFER_LENGTH position, start checking for buffer overruns.
// When we check, schedule the next check for MAX_BUFFER_LENGTH - (max(buffer lengths)),
// since that's the earliest that a buffer overrun could occur.  This way, checks are
// as rare as required, but as often as necessary to ensure never crossing this bound.
// Furthermore, buffers are only tested at most once per write(), so passing a very
// large string into write() might have undesirable effects, but this is manageable by
// the caller, so it is assumed to be safe.  Thus, a call to write() may, in the extreme
// edge case, result in creating at most one complete copy of the string passed in.
// Set to Infinity to have unlimited buffers.
sax.MAX_BUFFER_LENGTH = 64 * 1024

var buffers = [
  "comment", "sgmlDecl", "textNode", "tagName", "doctype",
  "procInstName", "procInstBody", "entity", "attribName",
  "attribValue", "cdata", "script"
]

sax.EVENTS = // for discoverability.
  [ "text"
  , "processinginstruction"
  , "sgmldeclaration"
  , "doctype"
  , "comment"
  , "attribute"
  , "opentag"
  , "closetag"
  , "opencdata"
  , "cdata"
  , "closecdata"
  , "error"
  , "end"
  , "ready"
  , "script"
  , "opennamespace"
  , "closenamespace"
  ]

function SAXParser (strict, opt) {
  if (!(this instanceof SAXParser)) return new SAXParser(strict, opt)

  var parser = this
  clearBuffers(parser)
  parser.q = parser.c = ""
  parser.bufferCheckPosition = sax.MAX_BUFFER_LENGTH
  parser.opt = opt || {}
  parser.tagCase = parser.opt.lowercasetags ? "toLowerCase" : "toUpperCase"
  parser.tags = []
  parser.closed = parser.closedRoot = parser.sawRoot = false
  parser.tag = parser.error = null
  parser.strict = !!strict
  parser.noscript = !!(strict || parser.opt.noscript)
  parser.state = S.BEGIN
  parser.ENTITIES = Object.create(sax.ENTITIES)
  parser.attribList = []

  // namespaces form a prototype chain.
  // it always points at the current tag,
  // which protos to its parent tag.
  if (parser.opt.xmlns) parser.ns = Object.create(rootNS)

  // mostly just for error reporting
  parser.position = parser.line = parser.column = 0
  emit(parser, "onready")
}

if (!Object.create) Object.create = function (o) {
  function f () { this.__proto__ = o }
  f.prototype = o
  return new f
}

if (!Object.getPrototypeOf) Object.getPrototypeOf = function (o) {
  return o.__proto__
}

if (!Object.keys) Object.keys = function (o) {
  var a = []
  for (var i in o) if (o.hasOwnProperty(i)) a.push(i)
  return a
}

function checkBufferLength (parser) {
  var maxAllowed = Math.max(sax.MAX_BUFFER_LENGTH, 10)
    , maxActual = 0
  for (var i = 0, l = buffers.length; i < l; i ++) {
    var len = parser[buffers[i]].length
    if (len > maxAllowed) {
      // Text/cdata nodes can get big, and since they're buffered,
      // we can get here under normal conditions.
      // Avoid issues by emitting the text node now,
      // so at least it won't get any bigger.
      switch (buffers[i]) {
        case "textNode":
          closeText(parser)
        break

        case "cdata":
          emitNode(parser, "oncdata", parser.cdata)
          parser.cdata = ""
        break

        case "script":
          emitNode(parser, "onscript", parser.script)
          parser.script = ""
        break

        default:
          error(parser, "Max buffer length exceeded: "+buffers[i])
      }
    }
    maxActual = Math.max(maxActual, len)
  }
  // schedule the next check for the earliest possible buffer overrun.
  parser.bufferCheckPosition = (sax.MAX_BUFFER_LENGTH - maxActual)
                             + parser.position
}

function clearBuffers (parser) {
  for (var i = 0, l = buffers.length; i < l; i ++) {
    parser[buffers[i]] = ""
  }
}

SAXParser.prototype =
  { end: function () { end(this) }
  , write: write
  , resume: function () { this.error = null; return this }
  , close: function () { return this.write(null) }
  , end: function () { return this.write(null) }
  }

try {
  var Stream = require("stream").Stream
} catch (ex) {
  var Stream = function () {}
}


var streamWraps = sax.EVENTS.filter(function (ev) {
  return ev !== "error" && ev !== "end"
})

function createStream (strict, opt) {
  return new SAXStream(strict, opt)
}

function SAXStream (strict, opt) {
  if (!(this instanceof SAXStream)) return new SAXStream(strict, opt)

  Stream.apply(me)

  this._parser = new SAXParser(strict, opt)
  this.writable = true
  this.readable = true


  var me = this

  this._parser.onend = function () {
    me.emit("end")
  }

  this._parser.onerror = function (er) {
    me.emit("error", er)

    // if didn't throw, then means error was handled.
    // go ahead and clear error, so we can write again.
    me._parser.error = null
  }

  streamWraps.forEach(function (ev) {
    Object.defineProperty(me, "on" + ev, {
      get: function () { return me._parser["on" + ev] },
      set: function (h) {
        if (!h) {
          me.removeAllListeners(ev)
          return me._parser["on"+ev] = h
        }
        me.on(ev, h)
      },
      enumerable: true,
      configurable: false
    })
  })
}

SAXStream.prototype = Object.create(Stream.prototype,
  { constructor: { value: SAXStream } })

SAXStream.prototype.write = function (data) {
  this._parser.write(data.toString())
  this.emit("data", data)
  return true
}

SAXStream.prototype.end = function (chunk) {
  if (chunk && chunk.length) this._parser.write(chunk.toString())
  this._parser.end()
  return true
}

SAXStream.prototype.on = function (ev, handler) {
  var me = this
  if (!me._parser["on"+ev] && streamWraps.indexOf(ev) !== -1) {
    me._parser["on"+ev] = function () {
      var args = arguments.length === 1 ? [arguments[0]]
               : Array.apply(null, arguments)
      args.splice(0, 0, ev)
      me.emit.apply(me, args)
    }
  }

  return Stream.prototype.on.call(me, ev, handler)
}



// character classes and tokens
var whitespace = "\r\n\t "
  // this really needs to be replaced with character classes.
  // XML allows all manner of ridiculous numbers and digits.
  , number = "0124356789"
  , letter = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
  // (Letter | "_" | ":")
  , nameStart = letter+"_:"
  , nameBody = nameStart+number+"-."
  , quote = "'\""
  , entity = number+letter+"#"
  , attribEnd = whitespace + ">"
  , CDATA = "[CDATA["
  , DOCTYPE = "DOCTYPE"
  , XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace"
  , XMLNS_NAMESPACE = "http://www.w3.org/2000/xmlns/"
  , rootNS = { xml: XML_NAMESPACE, xmlns: XMLNS_NAMESPACE }

// turn all the string character sets into character class objects.
whitespace = charClass(whitespace)
number = charClass(number)
letter = charClass(letter)
nameStart = charClass(nameStart)
nameBody = charClass(nameBody)
quote = charClass(quote)
entity = charClass(entity)
attribEnd = charClass(attribEnd)

function charClass (str) {
  return str.split("").reduce(function (s, c) {
    s[c] = true
    return s
  }, {})
}

function is (charclass, c) {
  return charclass[c]
}

function not (charclass, c) {
  return !charclass[c]
}

var S = 0
sax.STATE =
{ BEGIN                     : S++
, TEXT                      : S++ // general stuff
, TEXT_ENTITY               : S++ // &amp and such.
, OPEN_WAKA                 : S++ // <
, SGML_DECL                 : S++ // <!BLARG
, SGML_DECL_QUOTED          : S++ // <!BLARG foo "bar
, DOCTYPE                   : S++ // <!DOCTYPE
, DOCTYPE_QUOTED            : S++ // <!DOCTYPE "//blah
, DOCTYPE_DTD               : S++ // <!DOCTYPE "//blah" [ ...
, DOCTYPE_DTD_QUOTED        : S++ // <!DOCTYPE "//blah" [ "foo
, COMMENT_STARTING          : S++ // <!-
, COMMENT                   : S++ // <!--
, COMMENT_ENDING            : S++ // <!-- blah -
, COMMENT_ENDED             : S++ // <!-- blah --
, CDATA                     : S++ // <![CDATA[ something
, CDATA_ENDING              : S++ // ]
, CDATA_ENDING_2            : S++ // ]]
, PROC_INST                 : S++ // <?hi
, PROC_INST_BODY            : S++ // <?hi there
, PROC_INST_QUOTED          : S++ // <?hi "there
, PROC_INST_ENDING          : S++ // <?hi "there" ?
, OPEN_TAG                  : S++ // <strong
, OPEN_TAG_SLASH            : S++ // <strong /
, ATTRIB                    : S++ // <a
, ATTRIB_NAME               : S++ // <a foo
, ATTRIB_NAME_SAW_WHITE     : S++ // <a foo _
, ATTRIB_VALUE              : S++ // <a foo=
, ATTRIB_VALUE_QUOTED       : S++ // <a foo="bar
, ATTRIB_VALUE_UNQUOTED     : S++ // <a foo=bar
, ATTRIB_VALUE_ENTITY_Q     : S++ // <foo bar="&quot;"
, ATTRIB_VALUE_ENTITY_U     : S++ // <foo bar=&quot;
, CLOSE_TAG                 : S++ // </a
, CLOSE_TAG_SAW_WHITE       : S++ // </a   >
, SCRIPT                    : S++ // <script> ...
, SCRIPT_ENDING             : S++ // <script> ... <
}

sax.ENTITIES =
{ "apos" : "'"
, "quot" : "\""
, "amp"  : "&"
, "gt"   : ">"
, "lt"   : "<"
}

for (var S in sax.STATE) sax.STATE[sax.STATE[S]] = S

// shorthand
S = sax.STATE

function emit (parser, event, data) {
  parser[event] && parser[event](data)
}

function emitNode (parser, nodeType, data) {
  if (parser.textNode) closeText(parser)
  emit(parser, nodeType, data)
}

function closeText (parser) {
  parser.textNode = textopts(parser.opt, parser.textNode)
  if (parser.textNode) emit(parser, "ontext", parser.textNode)
  parser.textNode = ""
}

function textopts (opt, text) {
  if (opt.trim) text = text.trim()
  if (opt.normalize) text = text.replace(/\s+/g, " ")
  return text
}

function error (parser, er) {
  closeText(parser)
  er += "\nLine: "+parser.line+
        "\nColumn: "+parser.column+
        "\nChar: "+parser.c
  er = new Error(er)
  parser.error = er
  emit(parser, "onerror", er)
  return parser
}

function end (parser) {
  if (parser.state !== S.TEXT) error(parser, "Unexpected end")
  closeText(parser)
  parser.c = ""
  parser.closed = true
  emit(parser, "onend")
  SAXParser.call(parser, parser.strict, parser.opt)
  return parser
}

function strictFail (parser, message) {
  if (parser.strict) error(parser, message)
}

function newTag (parser) {
  if (!parser.strict) parser.tagName = parser.tagName[parser.tagCase]()
  var parent = parser.tags[parser.tags.length - 1] || parser
    , tag = parser.tag = { name : parser.tagName, attributes : {} }

  // will be overridden if tag contails an xmlns="foo" or xmlns:foo="bar"
  if (parser.opt.xmlns) tag.ns = parent.ns
  parser.attribList.length = 0
}

function qname (name) {
  var i = name.indexOf(":")
    , qualName = i < 0 ? [ "", name ] : name.split(":")
    , prefix = qualName[0]
    , local = qualName[1]

  // <x "xmlns"="http://foo">
  if (name === "xmlns") {
    prefix = "xmlns"
    local = ""
  }

  return { prefix: prefix, local: local }
}

function attrib (parser) {
  if (parser.opt.xmlns) {
    var qn = qname(parser.attribName)
      , prefix = qn.prefix
      , local = qn.local

    if (prefix === "xmlns") {
      // namespace binding attribute; push the binding into scope
      if (local === "xml" && parser.attribValue !== XML_NAMESPACE) {
        strictFail( parser
                  , "xml: prefix must be bound to " + XML_NAMESPACE + "\n"
                  + "Actual: " + parser.attribValue )
      } else if (local === "xmlns" && parser.attribValue !== XMLNS_NAMESPACE) {
        strictFail( parser
                  , "xmlns: prefix must be bound to " + XMLNS_NAMESPACE + "\n"
                  + "Actual: " + parser.attribValue )
      } else {
        var tag = parser.tag
          , parent = parser.tags[parser.tags.length - 1] || parser
        if (tag.ns === parent.ns) {
          tag.ns = Object.create(parent.ns)
        }
        tag.ns[local] = parser.attribValue
      }
    }

    // defer onattribute events until all attributes have been seen
    // so any new bindings can take effect; preserve attribute order
    // so deferred events can be emitted in document order
    parser.attribList.push([parser.attribName, parser.attribValue])
  } else {
    // in non-xmlns mode, we can emit the event right away
    parser.tag.attributes[parser.attribName] = parser.attribValue
    emitNode( parser
            , "onattribute"
            , { name: parser.attribName
              , value: parser.attribValue } )
  }

  parser.attribName = parser.attribValue = ""
}

function openTag (parser, selfClosing) {
  if (parser.opt.xmlns) {
    // emit namespace binding events
    var tag = parser.tag

    // add namespace info to tag
    var qn = qname(parser.tagName)
    tag.prefix = qn.prefix
    tag.local = qn.local
    tag.uri = tag.ns[qn.prefix] || qn.prefix

    if (tag.prefix && !tag.uri) {
      strictFail(parser, "Unbound namespace prefix: "
                       + JSON.stringify(parser.tagName))
    }

    var parent = parser.tags[parser.tags.length - 1] || parser
    if (tag.ns && parent.ns !== tag.ns) {
      Object.keys(tag.ns).forEach(function (p) {
        emitNode( parser
                , "onopennamespace"
                , { prefix: p , uri: tag.ns[p] } )
      })
    }

    // handle deferred onattribute events
    for (var i = 0, l = parser.attribList.length; i < l; i ++) {
      var nv = parser.attribList[i]
      var name = nv[0]
        , value = nv[1]
        , qualName = qname(name)
        , prefix = qualName.prefix
        , local = qualName.local
        , uri = tag.ns[prefix] || ""
        , a = { name: name
              , value: value
              , prefix: prefix
              , local: local
              , uri: uri
              }

      // if there's any attributes with an undefined namespace,
      // then fail on them now.
      if (prefix && prefix != "xmlns" && !uri) {
        strictFail(parser, "Unbound namespace prefix: "
                         + JSON.stringify(prefix))
        a.uri = prefix
      }
      parser.tag.attributes[name] = a
      emitNode(parser, "onattribute", a)
    }
    parser.attribList.length = 0
  }

  // process the tag
  parser.sawRoot = true
  parser.tags.push(parser.tag)
  emitNode(parser, "onopentag", parser.tag)
  if (!selfClosing) {
    // special case for <script> in non-strict mode.
    if (!parser.noscript && parser.tagName.toLowerCase() === "script") {
      parser.state = S.SCRIPT
    } else {
      parser.state = S.TEXT
    }
    parser.tag = null
    parser.tagName = ""
  }
  parser.attribName = parser.attribValue = ""
  parser.attribList.length = 0
}

function closeTag (parser) {
  if (!parser.tagName) {
    strictFail(parser, "Weird empty close tag.")
    parser.textNode += "</>"
    parser.state = S.TEXT
    return
  }
  // first make sure that the closing tag actually exists.
  // <a><b></c></b></a> will close everything, otherwise.
  var t = parser.tags.length
  var tagName = parser.tagName
  if (!parser.strict) tagName = tagName[parser.tagCase]()
  var closeTo = tagName
  while (t --) {
    var close = parser.tags[t]
    if (close.name !== closeTo) {
      // fail the first time in strict mode
      strictFail(parser, "Unexpected close tag")
    } else break
  }

  // didn't find it.  we already failed for strict, so just abort.
  if (t < 0) {
    strictFail(parser, "Unmatched closing tag: "+parser.tagName)
    parser.textNode += "</" + parser.tagName + ">"
    parser.state = S.TEXT
    return
  }
  parser.tagName = tagName
  var s = parser.tags.length
  while (s --> t) {
    var tag = parser.tag = parser.tags.pop()
    parser.tagName = parser.tag.name
    emitNode(parser, "onclosetag", parser.tagName)

    var x = {}
    for (var i in tag.ns) x[i] = tag.ns[i]

    var parent = parser.tags[parser.tags.length - 1] || parser
    if (parser.opt.xmlns && tag.ns !== parent.ns) {
      // remove namespace bindings introduced by tag
      Object.keys(tag.ns).forEach(function (p) {
        var n = tag.ns[p]
        emitNode(parser, "onclosenamespace", { prefix: p, uri: n })
      })
    }
  }
  if (t === 0) parser.closedRoot = true
  parser.tagName = parser.attribValue = parser.attribName = ""
  parser.attribList.length = 0
  parser.state = S.TEXT
}

function parseEntity (parser) {
  var entity = parser.entity.toLowerCase()
    , num
    , numStr = ""
  if (parser.ENTITIES[entity]) return parser.ENTITIES[entity]
  if (entity.charAt(0) === "#") {
    if (entity.charAt(1) === "x") {
      entity = entity.slice(2)
      num = parseInt(entity, 16)
      numStr = num.toString(16)
    } else {
      entity = entity.slice(1)
      num = parseInt(entity, 10)
      numStr = num.toString(10)
    }
  }
  entity = entity.replace(/^0+/, "")
  if (numStr.toLowerCase() !== entity) {
    strictFail(parser, "Invalid character entity")
    return "&"+parser.entity + ";"
  }
  return String.fromCharCode(num)
}

function write (chunk) {
  var parser = this
  if (this.error) throw this.error
  if (parser.closed) return error(parser,
    "Cannot write after close. Assign an onready handler.")
  if (chunk === null) return end(parser)
  var i = 0, c = ""
  while (parser.c = c = chunk.charAt(i++)) {
    parser.position ++
    if (c === "\n") {
      parser.line ++
      parser.column = 0
    } else parser.column ++
    switch (parser.state) {

      case S.BEGIN:
        if (c === "<") parser.state = S.OPEN_WAKA
        else if (not(whitespace,c)) {
          // have to process this as a text node.
          // weird, but happens.
          strictFail(parser, "Non-whitespace before first tag.")
          parser.textNode = c
          parser.state = S.TEXT
        }
      continue

      case S.TEXT:
        if (parser.sawRoot && !parser.closedRoot) {
          var starti = i-1
          while (c && c!=="<" && c!=="&") {
            c = chunk.charAt(i++)
            if (c) {
              parser.position ++
              if (c === "\n") {
                parser.line ++
                parser.column = 0
              } else parser.column ++
            }
          }
          parser.textNode += chunk.substring(starti, i-1)
        }
        if (c === "<") parser.state = S.OPEN_WAKA
        else {
          if (not(whitespace, c) && (!parser.sawRoot || parser.closedRoot))
            strictFail("Text data outside of root node.")
          if (c === "&") parser.state = S.TEXT_ENTITY
          else parser.textNode += c
        }
      continue

      case S.SCRIPT:
        // only non-strict
        if (c === "<") {
          parser.state = S.SCRIPT_ENDING
        } else parser.script += c
      continue

      case S.SCRIPT_ENDING:
        if (c === "/") {
          emitNode(parser, "onscript", parser.script)
          parser.state = S.CLOSE_TAG
          parser.script = ""
          parser.tagName = ""
        } else {
          parser.script += "<" + c
          parser.state = S.SCRIPT
        }
      continue

      case S.OPEN_WAKA:
        // either a /, ?, !, or text is coming next.
        if (c === "!") {
          parser.state = S.SGML_DECL
          parser.sgmlDecl = ""
        } else if (is(whitespace, c)) {
          // wait for it...
        } else if (is(nameStart,c)) {
          parser.startTagPosition = parser.position - 1
          parser.state = S.OPEN_TAG
          parser.tagName = c
        } else if (c === "/") {
          parser.startTagPosition = parser.position - 1
          parser.state = S.CLOSE_TAG
          parser.tagName = ""
        } else if (c === "?") {
          parser.state = S.PROC_INST
          parser.procInstName = parser.procInstBody = ""
        } else {
          strictFail(parser, "Unencoded <")
          parser.textNode += "<" + c
          parser.state = S.TEXT
        }
      continue

      case S.SGML_DECL:
        if ((parser.sgmlDecl+c).toUpperCase() === CDATA) {
          emitNode(parser, "onopencdata")
          parser.state = S.CDATA
          parser.sgmlDecl = ""
          parser.cdata = ""
        } else if (parser.sgmlDecl+c === "--") {
          parser.state = S.COMMENT
          parser.comment = ""
          parser.sgmlDecl = ""
        } else if ((parser.sgmlDecl+c).toUpperCase() === DOCTYPE) {
          parser.state = S.DOCTYPE
          if (parser.doctype || parser.sawRoot) strictFail(parser,
            "Inappropriately located doctype declaration")
          parser.doctype = ""
          parser.sgmlDecl = ""
        } else if (c === ">") {
          emitNode(parser, "onsgmldeclaration", parser.sgmlDecl)
          parser.sgmlDecl = ""
          parser.state = S.TEXT
        } else if (is(quote, c)) {
          parser.state = S.SGML_DECL_QUOTED
          parser.sgmlDecl += c
        } else parser.sgmlDecl += c
      continue

      case S.SGML_DECL_QUOTED:
        if (c === parser.q) {
          parser.state = S.SGML_DECL
          parser.q = ""
        }
        parser.sgmlDecl += c
      continue

      case S.DOCTYPE:
        if (c === ">") {
          parser.state = S.TEXT
          emitNode(parser, "ondoctype", parser.doctype)
          parser.doctype = true // just remember that we saw it.
        } else {
          parser.doctype += c
          if (c === "[") parser.state = S.DOCTYPE_DTD
          else if (is(quote, c)) {
            parser.state = S.DOCTYPE_QUOTED
            parser.q = c
          }
        }
      continue

      case S.DOCTYPE_QUOTED:
        parser.doctype += c
        if (c === parser.q) {
          parser.q = ""
          parser.state = S.DOCTYPE
        }
      continue

      case S.DOCTYPE_DTD:
        parser.doctype += c
        if (c === "]") parser.state = S.DOCTYPE
        else if (is(quote,c)) {
          parser.state = S.DOCTYPE_DTD_QUOTED
          parser.q = c
        }
      continue

      case S.DOCTYPE_DTD_QUOTED:
        parser.doctype += c
        if (c === parser.q) {
          parser.state = S.DOCTYPE_DTD
          parser.q = ""
        }
      continue

      case S.COMMENT:
        if (c === "-") parser.state = S.COMMENT_ENDING
        else parser.comment += c
      continue

      case S.COMMENT_ENDING:
        if (c === "-") {
          parser.state = S.COMMENT_ENDED
          parser.comment = textopts(parser.opt, parser.comment)
          if (parser.comment) emitNode(parser, "oncomment", parser.comment)
          parser.comment = ""
        } else {
          parser.comment += "-" + c
          parser.state = S.COMMENT
        }
      continue

      case S.COMMENT_ENDED:
        if (c !== ">") {
          strictFail(parser, "Malformed comment")
          // allow <!-- blah -- bloo --> in non-strict mode,
          // which is a comment of " blah -- bloo "
          parser.comment += "--" + c
          parser.state = S.COMMENT
        } else parser.state = S.TEXT
      continue

      case S.CDATA:
        if (c === "]") parser.state = S.CDATA_ENDING
        else parser.cdata += c
      continue

      case S.CDATA_ENDING:
        if (c === "]") parser.state = S.CDATA_ENDING_2
        else {
          parser.cdata += "]" + c
          parser.state = S.CDATA
        }
      continue

      case S.CDATA_ENDING_2:
        if (c === ">") {
          if (parser.cdata) emitNode(parser, "oncdata", parser.cdata)
          emitNode(parser, "onclosecdata")
          parser.cdata = ""
          parser.state = S.TEXT
        } else if (c === "]") {
          parser.cdata += "]"
        } else {
          parser.cdata += "]]" + c
          parser.state = S.CDATA
        }
      continue

      case S.PROC_INST:
        if (c === "?") parser.state = S.PROC_INST_ENDING
        else if (is(whitespace, c)) parser.state = S.PROC_INST_BODY
        else parser.procInstName += c
      continue

      case S.PROC_INST_BODY:
        if (!parser.procInstBody && is(whitespace, c)) continue
        else if (c === "?") parser.state = S.PROC_INST_ENDING
        else if (is(quote, c)) {
          parser.state = S.PROC_INST_QUOTED
          parser.q = c
          parser.procInstBody += c
        } else parser.procInstBody += c
      continue

      case S.PROC_INST_ENDING:
        if (c === ">") {
          emitNode(parser, "onprocessinginstruction", {
            name : parser.procInstName,
            body : parser.procInstBody
          })
          parser.procInstName = parser.procInstBody = ""
          parser.state = S.TEXT
        } else {
          parser.procInstBody += "?" + c
          parser.state = S.PROC_INST_BODY
        }
      continue

      case S.PROC_INST_QUOTED:
        parser.procInstBody += c
        if (c === parser.q) {
          parser.state = S.PROC_INST_BODY
          parser.q = ""
        }
      continue

      case S.OPEN_TAG:
        if (is(nameBody, c)) parser.tagName += c
        else {
          newTag(parser)
          if (c === ">") openTag(parser)
          else if (c === "/") parser.state = S.OPEN_TAG_SLASH
          else {
            if (not(whitespace, c)) strictFail(
              parser, "Invalid character in tag name")
            parser.state = S.ATTRIB
          }
        }
      continue

      case S.OPEN_TAG_SLASH:
        if (c === ">") {
          openTag(parser, true)
          closeTag(parser)
        } else {
          strictFail(parser, "Forward-slash in opening tag not followed by >")
          parser.state = S.ATTRIB
        }
      continue

      case S.ATTRIB:
        // haven't read the attribute name yet.
        if (is(whitespace, c)) continue
        else if (c === ">") openTag(parser)
        else if (c === "/") parser.state = S.OPEN_TAG_SLASH
        else if (is(nameStart, c)) {
          parser.attribName = c
          parser.attribValue = ""
          parser.state = S.ATTRIB_NAME
        } else strictFail(parser, "Invalid attribute name")
      continue

      case S.ATTRIB_NAME:
        if (c === "=") parser.state = S.ATTRIB_VALUE
        else if (is(whitespace, c)) parser.state = S.ATTRIB_NAME_SAW_WHITE
        else if (is(nameBody, c)) parser.attribName += c
        else strictFail(parser, "Invalid attribute name")
      continue

      case S.ATTRIB_NAME_SAW_WHITE:
        if (c === "=") parser.state = S.ATTRIB_VALUE
        else if (is(whitespace, c)) continue
        else {
          strictFail(parser, "Attribute without value")
          parser.tag.attributes[parser.attribName] = ""
          parser.attribValue = ""
          emitNode(parser, "onattribute",
                   { name : parser.attribName, value : "" })
          parser.attribName = ""
          if (c === ">") openTag(parser)
          else if (is(nameStart, c)) {
            parser.attribName = c
            parser.state = S.ATTRIB_NAME
          } else {
            strictFail(parser, "Invalid attribute name")
            parser.state = S.ATTRIB
          }
        }
      continue

      case S.ATTRIB_VALUE:
        if (is(whitespace, c)) continue
        else if (is(quote, c)) {
          parser.q = c
          parser.state = S.ATTRIB_VALUE_QUOTED
        } else {
          strictFail(parser, "Unquoted attribute value")
          parser.state = S.ATTRIB_VALUE_UNQUOTED
          parser.attribValue = c
        }
      continue

      case S.ATTRIB_VALUE_QUOTED:
        if (c !== parser.q) {
          if (c === "&") parser.state = S.ATTRIB_VALUE_ENTITY_Q
          else parser.attribValue += c
          continue
        }
        attrib(parser)
        parser.q = ""
        parser.state = S.ATTRIB
      continue

      case S.ATTRIB_VALUE_UNQUOTED:
        if (not(attribEnd,c)) {
          if (c === "&") parser.state = S.ATTRIB_VALUE_ENTITY_U
          else parser.attribValue += c
          continue
        }
        attrib(parser)
        if (c === ">") openTag(parser)
        else parser.state = S.ATTRIB
      continue

      case S.CLOSE_TAG:
        if (!parser.tagName) {
          if (is(whitespace, c)) continue
          else if (not(nameStart, c)) strictFail(parser,
            "Invalid tagname in closing tag.")
          else parser.tagName = c
        }
        else if (c === ">") closeTag(parser)
        else if (is(nameBody, c)) parser.tagName += c
        else {
          if (not(whitespace, c)) strictFail(parser,
            "Invalid tagname in closing tag")
          parser.state = S.CLOSE_TAG_SAW_WHITE
        }
      continue

      case S.CLOSE_TAG_SAW_WHITE:
        if (is(whitespace, c)) continue
        if (c === ">") closeTag(parser)
        else strictFail("Invalid characters in closing tag")
      continue

      case S.TEXT_ENTITY:
      case S.ATTRIB_VALUE_ENTITY_Q:
      case S.ATTRIB_VALUE_ENTITY_U:
        switch(parser.state) {
          case S.TEXT_ENTITY:
            var returnState = S.TEXT, buffer = "textNode"
          break

          case S.ATTRIB_VALUE_ENTITY_Q:
            var returnState = S.ATTRIB_VALUE_QUOTED, buffer = "attribValue"
          break

          case S.ATTRIB_VALUE_ENTITY_U:
            var returnState = S.ATTRIB_VALUE_UNQUOTED, buffer = "attribValue"
          break
        }
        if (c === ";") {
          parser[buffer] += parseEntity(parser)
          parser.entity = ""
          parser.state = returnState
        }
        else if (is(entity, c)) parser.entity += c
        else {
          strictFail("Invalid character entity")
          parser[buffer] += "&" + parser.entity + c
          parser.entity = ""
          parser.state = returnState
        }
      continue

      default:
        throw new Error(parser, "Unknown state: " + parser.state)
    }
  } // while
  // cdata blocks can get very big under normal conditions. emit and move on.
  // if (parser.state === S.CDATA && parser.cdata) {
  //   emitNode(parser, "oncdata", parser.cdata)
  //   parser.cdata = ""
  // }
  if (parser.position >= parser.bufferCheckPosition) checkBufferLength(parser)
  return parser
}

})(typeof exports === "undefined" ? sax = {} : exports)

});

require.define("stream",function(require,module,exports,__dirname,__filename,process,global){var events = require('events');
var util = require('util');

function Stream() {
  events.EventEmitter.call(this);
}
util.inherits(Stream, events.EventEmitter);
module.exports = Stream;
// Backwards-compat with node 0.4.x
Stream.Stream = Stream;

Stream.prototype.pipe = function(dest, options) {
  var source = this;

  function ondata(chunk) {
    if (dest.writable) {
      if (false === dest.write(chunk) && source.pause) {
        source.pause();
      }
    }
  }

  source.on('data', ondata);

  function ondrain() {
    if (source.readable && source.resume) {
      source.resume();
    }
  }

  dest.on('drain', ondrain);

  // If the 'end' option is not supplied, dest.end() will be called when
  // source gets the 'end' or 'close' events.  Only dest.end() once, and
  // only when all sources have ended.
  if (!dest._isStdio && (!options || options.end !== false)) {
    dest._pipeCount = dest._pipeCount || 0;
    dest._pipeCount++;

    source.on('end', onend);
    source.on('close', onclose);
  }

  var didOnEnd = false;
  function onend() {
    if (didOnEnd) return;
    didOnEnd = true;

    dest._pipeCount--;

    // remove the listeners
    cleanup();

    if (dest._pipeCount > 0) {
      // waiting for other incoming streams to end.
      return;
    }

    dest.end();
  }


  function onclose() {
    if (didOnEnd) return;
    didOnEnd = true;

    dest._pipeCount--;

    // remove the listeners
    cleanup();

    if (dest._pipeCount > 0) {
      // waiting for other incoming streams to end.
      return;
    }

    dest.destroy();
  }

  // don't leave dangling pipes when there are errors.
  function onerror(er) {
    cleanup();
    if (this.listeners('error').length === 0) {
      throw er; // Unhandled stream error in pipe.
    }
  }

  source.on('error', onerror);
  dest.on('error', onerror);

  // remove all the event listeners that were added.
  function cleanup() {
    source.removeListener('data', ondata);
    dest.removeListener('drain', ondrain);

    source.removeListener('end', onend);
    source.removeListener('close', onclose);

    source.removeListener('error', onerror);
    dest.removeListener('error', onerror);

    source.removeListener('end', cleanup);
    source.removeListener('close', cleanup);

    dest.removeListener('end', cleanup);
    dest.removeListener('close', cleanup);
  }

  source.on('end', cleanup);
  source.on('close', cleanup);

  dest.on('end', cleanup);
  dest.on('close', cleanup);

  dest.emit('pipe', source);

  // Allow for unix-like usage: A.pipe(B).pipe(C)
  return dest;
};

});

require.define("/node_modules/elementtree/lib/constants.js",function(require,module,exports,__dirname,__filename,process,global){/*
 *  Copyright 2011 Rackspace
 *
 *  Licensed under the Apache License, Version 2.0 (the "License");
 *  you may not use this file except in compliance with the License.
 *  You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing, software
 *  distributed under the License is distributed on an "AS IS" BASIS,
 *  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *  See the License for the specific language governing permissions and
 *  limitations under the License.
 *
 */

var DEFAULT_PARSER = 'sax';

exports.DEFAULT_PARSER = DEFAULT_PARSER;

});

require.define("url",function(require,module,exports,__dirname,__filename,process,global){var punycode = { encode : function (s) { return s } };

exports.parse = urlParse;
exports.resolve = urlResolve;
exports.resolveObject = urlResolveObject;
exports.format = urlFormat;

function arrayIndexOf(array, subject) {
    for (var i = 0, j = array.length; i < j; i++) {
        if(array[i] == subject) return i;
    }
    return -1;
}

var objectKeys = Object.keys || function objectKeys(object) {
    if (object !== Object(object)) throw new TypeError('Invalid object');
    var keys = [];
    for (var key in object) if (object.hasOwnProperty(key)) keys[keys.length] = key;
    return keys;
}

// Reference: RFC 3986, RFC 1808, RFC 2396

// define these here so at least they only have to be
// compiled once on the first module load.
var protocolPattern = /^([a-z0-9.+-]+:)/i,
    portPattern = /:[0-9]+$/,
    // RFC 2396: characters reserved for delimiting URLs.
    delims = ['<', '>', '"', '`', ' ', '\r', '\n', '\t'],
    // RFC 2396: characters not allowed for various reasons.
    unwise = ['{', '}', '|', '\\', '^', '~', '[', ']', '`'].concat(delims),
    // Allowed by RFCs, but cause of XSS attacks.  Always escape these.
    autoEscape = ['\''],
    // Characters that are never ever allowed in a hostname.
    // Note that any invalid chars are also handled, but these
    // are the ones that are *expected* to be seen, so we fast-path
    // them.
    nonHostChars = ['%', '/', '?', ';', '#']
      .concat(unwise).concat(autoEscape),
    nonAuthChars = ['/', '@', '?', '#'].concat(delims),
    hostnameMaxLen = 255,
    hostnamePartPattern = /^[a-zA-Z0-9][a-z0-9A-Z_-]{0,62}$/,
    hostnamePartStart = /^([a-zA-Z0-9][a-z0-9A-Z_-]{0,62})(.*)$/,
    // protocols that can allow "unsafe" and "unwise" chars.
    unsafeProtocol = {
      'javascript': true,
      'javascript:': true
    },
    // protocols that never have a hostname.
    hostlessProtocol = {
      'javascript': true,
      'javascript:': true
    },
    // protocols that always have a path component.
    pathedProtocol = {
      'http': true,
      'https': true,
      'ftp': true,
      'gopher': true,
      'file': true,
      'http:': true,
      'ftp:': true,
      'gopher:': true,
      'file:': true
    },
    // protocols that always contain a // bit.
    slashedProtocol = {
      'http': true,
      'https': true,
      'ftp': true,
      'gopher': true,
      'file': true,
      'http:': true,
      'https:': true,
      'ftp:': true,
      'gopher:': true,
      'file:': true
    },
    querystring = require('querystring');

function urlParse(url, parseQueryString, slashesDenoteHost) {
  if (url && typeof(url) === 'object' && url.href) return url;

  if (typeof url !== 'string') {
    throw new TypeError("Parameter 'url' must be a string, not " + typeof url);
  }

  var out = {},
      rest = url;

  // cut off any delimiters.
  // This is to support parse stuff like "<http://foo.com>"
  for (var i = 0, l = rest.length; i < l; i++) {
    if (arrayIndexOf(delims, rest.charAt(i)) === -1) break;
  }
  if (i !== 0) rest = rest.substr(i);


  var proto = protocolPattern.exec(rest);
  if (proto) {
    proto = proto[0];
    var lowerProto = proto.toLowerCase();
    out.protocol = lowerProto;
    rest = rest.substr(proto.length);
  }

  // figure out if it's got a host
  // user@server is *always* interpreted as a hostname, and url
  // resolution will treat //foo/bar as host=foo,path=bar because that's
  // how the browser resolves relative URLs.
  if (slashesDenoteHost || proto || rest.match(/^\/\/[^@\/]+@[^@\/]+/)) {
    var slashes = rest.substr(0, 2) === '//';
    if (slashes && !(proto && hostlessProtocol[proto])) {
      rest = rest.substr(2);
      out.slashes = true;
    }
  }

  if (!hostlessProtocol[proto] &&
      (slashes || (proto && !slashedProtocol[proto]))) {
    // there's a hostname.
    // the first instance of /, ?, ;, or # ends the host.
    // don't enforce full RFC correctness, just be unstupid about it.

    // If there is an @ in the hostname, then non-host chars *are* allowed
    // to the left of the first @ sign, unless some non-auth character
    // comes *before* the @-sign.
    // URLs are obnoxious.
    var atSign = arrayIndexOf(rest, '@');
    if (atSign !== -1) {
      // there *may be* an auth
      var hasAuth = true;
      for (var i = 0, l = nonAuthChars.length; i < l; i++) {
        var index = arrayIndexOf(rest, nonAuthChars[i]);
        if (index !== -1 && index < atSign) {
          // not a valid auth.  Something like http://foo.com/bar@baz/
          hasAuth = false;
          break;
        }
      }
      if (hasAuth) {
        // pluck off the auth portion.
        out.auth = rest.substr(0, atSign);
        rest = rest.substr(atSign + 1);
      }
    }

    var firstNonHost = -1;
    for (var i = 0, l = nonHostChars.length; i < l; i++) {
      var index = arrayIndexOf(rest, nonHostChars[i]);
      if (index !== -1 &&
          (firstNonHost < 0 || index < firstNonHost)) firstNonHost = index;
    }

    if (firstNonHost !== -1) {
      out.host = rest.substr(0, firstNonHost);
      rest = rest.substr(firstNonHost);
    } else {
      out.host = rest;
      rest = '';
    }

    // pull out port.
    var p = parseHost(out.host);
    var keys = objectKeys(p);
    for (var i = 0, l = keys.length; i < l; i++) {
      var key = keys[i];
      out[key] = p[key];
    }

    // we've indicated that there is a hostname,
    // so even if it's empty, it has to be present.
    out.hostname = out.hostname || '';

    // validate a little.
    if (out.hostname.length > hostnameMaxLen) {
      out.hostname = '';
    } else {
      var hostparts = out.hostname.split(/\./);
      for (var i = 0, l = hostparts.length; i < l; i++) {
        var part = hostparts[i];
        if (!part) continue;
        if (!part.match(hostnamePartPattern)) {
          var newpart = '';
          for (var j = 0, k = part.length; j < k; j++) {
            if (part.charCodeAt(j) > 127) {
              // we replace non-ASCII char with a temporary placeholder
              // we need this to make sure size of hostname is not
              // broken by replacing non-ASCII by nothing
              newpart += 'x';
            } else {
              newpart += part[j];
            }
          }
          // we test again with ASCII char only
          if (!newpart.match(hostnamePartPattern)) {
            var validParts = hostparts.slice(0, i);
            var notHost = hostparts.slice(i + 1);
            var bit = part.match(hostnamePartStart);
            if (bit) {
              validParts.push(bit[1]);
              notHost.unshift(bit[2]);
            }
            if (notHost.length) {
              rest = '/' + notHost.join('.') + rest;
            }
            out.hostname = validParts.join('.');
            break;
          }
        }
      }
    }

    // hostnames are always lower case.
    out.hostname = out.hostname.toLowerCase();

    // IDNA Support: Returns a puny coded representation of "domain".
    // It only converts the part of the domain name that
    // has non ASCII characters. I.e. it dosent matter if
    // you call it with a domain that already is in ASCII.
    var domainArray = out.hostname.split('.');
    var newOut = [];
    for (var i = 0; i < domainArray.length; ++i) {
      var s = domainArray[i];
      newOut.push(s.match(/[^A-Za-z0-9_-]/) ?
          'xn--' + punycode.encode(s) : s);
    }
    out.hostname = newOut.join('.');

    out.host = (out.hostname || '') +
        ((out.port) ? ':' + out.port : '');
    out.href += out.host;
  }

  // now rest is set to the post-host stuff.
  // chop off any delim chars.
  if (!unsafeProtocol[lowerProto]) {

    // First, make 100% sure that any "autoEscape" chars get
    // escaped, even if encodeURIComponent doesn't think they
    // need to be.
    for (var i = 0, l = autoEscape.length; i < l; i++) {
      var ae = autoEscape[i];
      var esc = encodeURIComponent(ae);
      if (esc === ae) {
        esc = escape(ae);
      }
      rest = rest.split(ae).join(esc);
    }

    // Now make sure that delims never appear in a url.
    var chop = rest.length;
    for (var i = 0, l = delims.length; i < l; i++) {
      var c = arrayIndexOf(rest, delims[i]);
      if (c !== -1) {
        chop = Math.min(c, chop);
      }
    }
    rest = rest.substr(0, chop);
  }


  // chop off from the tail first.
  var hash = arrayIndexOf(rest, '#');
  if (hash !== -1) {
    // got a fragment string.
    out.hash = rest.substr(hash);
    rest = rest.slice(0, hash);
  }
  var qm = arrayIndexOf(rest, '?');
  if (qm !== -1) {
    out.search = rest.substr(qm);
    out.query = rest.substr(qm + 1);
    if (parseQueryString) {
      out.query = querystring.parse(out.query);
    }
    rest = rest.slice(0, qm);
  } else if (parseQueryString) {
    // no query string, but parseQueryString still requested
    out.search = '';
    out.query = {};
  }
  if (rest) out.pathname = rest;
  if (slashedProtocol[proto] &&
      out.hostname && !out.pathname) {
    out.pathname = '/';
  }

  //to support http.request
  if (out.pathname || out.search) {
    out.path = (out.pathname ? out.pathname : '') +
               (out.search ? out.search : '');
  }

  // finally, reconstruct the href based on what has been validated.
  out.href = urlFormat(out);
  return out;
}

// format a parsed object into a url string
function urlFormat(obj) {
  // ensure it's an object, and not a string url.
  // If it's an obj, this is a no-op.
  // this way, you can call url_format() on strings
  // to clean up potentially wonky urls.
  if (typeof(obj) === 'string') obj = urlParse(obj);

  var auth = obj.auth || '';
  if (auth) {
    auth = auth.split('@').join('%40');
    for (var i = 0, l = nonAuthChars.length; i < l; i++) {
      var nAC = nonAuthChars[i];
      auth = auth.split(nAC).join(encodeURIComponent(nAC));
    }
    auth += '@';
  }

  var protocol = obj.protocol || '',
      host = (obj.host !== undefined) ? auth + obj.host :
          obj.hostname !== undefined ? (
              auth + obj.hostname +
              (obj.port ? ':' + obj.port : '')
          ) :
          false,
      pathname = obj.pathname || '',
      query = obj.query &&
              ((typeof obj.query === 'object' &&
                objectKeys(obj.query).length) ?
                 querystring.stringify(obj.query) :
                 '') || '',
      search = obj.search || (query && ('?' + query)) || '',
      hash = obj.hash || '';

  if (protocol && protocol.substr(-1) !== ':') protocol += ':';

  // only the slashedProtocols get the //.  Not mailto:, xmpp:, etc.
  // unless they had them to begin with.
  if (obj.slashes ||
      (!protocol || slashedProtocol[protocol]) && host !== false) {
    host = '//' + (host || '');
    if (pathname && pathname.charAt(0) !== '/') pathname = '/' + pathname;
  } else if (!host) {
    host = '';
  }

  if (hash && hash.charAt(0) !== '#') hash = '#' + hash;
  if (search && search.charAt(0) !== '?') search = '?' + search;

  return protocol + host + pathname + search + hash;
}

function urlResolve(source, relative) {
  return urlFormat(urlResolveObject(source, relative));
}

function urlResolveObject(source, relative) {
  if (!source) return relative;

  source = urlParse(urlFormat(source), false, true);
  relative = urlParse(urlFormat(relative), false, true);

  // hash is always overridden, no matter what.
  source.hash = relative.hash;

  if (relative.href === '') {
    source.href = urlFormat(source);
    return source;
  }

  // hrefs like //foo/bar always cut to the protocol.
  if (relative.slashes && !relative.protocol) {
    relative.protocol = source.protocol;
    //urlParse appends trailing / to urls like http://www.example.com
    if (slashedProtocol[relative.protocol] &&
        relative.hostname && !relative.pathname) {
      relative.path = relative.pathname = '/';
    }
    relative.href = urlFormat(relative);
    return relative;
  }

  if (relative.protocol && relative.protocol !== source.protocol) {
    // if it's a known url protocol, then changing
    // the protocol does weird things
    // first, if it's not file:, then we MUST have a host,
    // and if there was a path
    // to begin with, then we MUST have a path.
    // if it is file:, then the host is dropped,
    // because that's known to be hostless.
    // anything else is assumed to be absolute.
    if (!slashedProtocol[relative.protocol]) {
      relative.href = urlFormat(relative);
      return relative;
    }
    source.protocol = relative.protocol;
    if (!relative.host && !hostlessProtocol[relative.protocol]) {
      var relPath = (relative.pathname || '').split('/');
      while (relPath.length && !(relative.host = relPath.shift()));
      if (!relative.host) relative.host = '';
      if (!relative.hostname) relative.hostname = '';
      if (relPath[0] !== '') relPath.unshift('');
      if (relPath.length < 2) relPath.unshift('');
      relative.pathname = relPath.join('/');
    }
    source.pathname = relative.pathname;
    source.search = relative.search;
    source.query = relative.query;
    source.host = relative.host || '';
    source.auth = relative.auth;
    source.hostname = relative.hostname || relative.host;
    source.port = relative.port;
    //to support http.request
    if (source.pathname !== undefined || source.search !== undefined) {
      source.path = (source.pathname ? source.pathname : '') +
                    (source.search ? source.search : '');
    }
    source.slashes = source.slashes || relative.slashes;
    source.href = urlFormat(source);
    return source;
  }

  var isSourceAbs = (source.pathname && source.pathname.charAt(0) === '/'),
      isRelAbs = (
          relative.host !== undefined ||
          relative.pathname && relative.pathname.charAt(0) === '/'
      ),
      mustEndAbs = (isRelAbs || isSourceAbs ||
                    (source.host && relative.pathname)),
      removeAllDots = mustEndAbs,
      srcPath = source.pathname && source.pathname.split('/') || [],
      relPath = relative.pathname && relative.pathname.split('/') || [],
      psychotic = source.protocol &&
          !slashedProtocol[source.protocol];

  // if the url is a non-slashed url, then relative
  // links like ../.. should be able
  // to crawl up to the hostname, as well.  This is strange.
  // source.protocol has already been set by now.
  // Later on, put the first path part into the host field.
  if (psychotic) {

    delete source.hostname;
    delete source.port;
    if (source.host) {
      if (srcPath[0] === '') srcPath[0] = source.host;
      else srcPath.unshift(source.host);
    }
    delete source.host;
    if (relative.protocol) {
      delete relative.hostname;
      delete relative.port;
      if (relative.host) {
        if (relPath[0] === '') relPath[0] = relative.host;
        else relPath.unshift(relative.host);
      }
      delete relative.host;
    }
    mustEndAbs = mustEndAbs && (relPath[0] === '' || srcPath[0] === '');
  }

  if (isRelAbs) {
    // it's absolute.
    source.host = (relative.host || relative.host === '') ?
                      relative.host : source.host;
    source.hostname = (relative.hostname || relative.hostname === '') ?
                      relative.hostname : source.hostname;
    source.search = relative.search;
    source.query = relative.query;
    srcPath = relPath;
    // fall through to the dot-handling below.
  } else if (relPath.length) {
    // it's relative
    // throw away the existing file, and take the new path instead.
    if (!srcPath) srcPath = [];
    srcPath.pop();
    srcPath = srcPath.concat(relPath);
    source.search = relative.search;
    source.query = relative.query;
  } else if ('search' in relative) {
    // just pull out the search.
    // like href='?foo'.
    // Put this after the other two cases because it simplifies the booleans
    if (psychotic) {
      source.hostname = source.host = srcPath.shift();
      //occationaly the auth can get stuck only in host
      //this especialy happens in cases like
      //url.resolveObject('mailto:local1@domain1', 'local2@domain2')
      var authInHost = source.host && arrayIndexOf(source.host, '@') > 0 ?
                       source.host.split('@') : false;
      if (authInHost) {
        source.auth = authInHost.shift();
        source.host = source.hostname = authInHost.shift();
      }
    }
    source.search = relative.search;
    source.query = relative.query;
    //to support http.request
    if (source.pathname !== undefined || source.search !== undefined) {
      source.path = (source.pathname ? source.pathname : '') +
                    (source.search ? source.search : '');
    }
    source.href = urlFormat(source);
    return source;
  }
  if (!srcPath.length) {
    // no path at all.  easy.
    // we've already handled the other stuff above.
    delete source.pathname;
    //to support http.request
    if (!source.search) {
      source.path = '/' + source.search;
    } else {
      delete source.path;
    }
    source.href = urlFormat(source);
    return source;
  }
  // if a url ENDs in . or .., then it must get a trailing slash.
  // however, if it ends in anything else non-slashy,
  // then it must NOT get a trailing slash.
  var last = srcPath.slice(-1)[0];
  var hasTrailingSlash = (
      (source.host || relative.host) && (last === '.' || last === '..') ||
      last === '');

  // strip single dots, resolve double dots to parent dir
  // if the path tries to go above the root, `up` ends up > 0
  var up = 0;
  for (var i = srcPath.length; i >= 0; i--) {
    last = srcPath[i];
    if (last == '.') {
      srcPath.splice(i, 1);
    } else if (last === '..') {
      srcPath.splice(i, 1);
      up++;
    } else if (up) {
      srcPath.splice(i, 1);
      up--;
    }
  }

  // if the path is allowed to go above the root, restore leading ..s
  if (!mustEndAbs && !removeAllDots) {
    for (; up--; up) {
      srcPath.unshift('..');
    }
  }

  if (mustEndAbs && srcPath[0] !== '' &&
      (!srcPath[0] || srcPath[0].charAt(0) !== '/')) {
    srcPath.unshift('');
  }

  if (hasTrailingSlash && (srcPath.join('/').substr(-1) !== '/')) {
    srcPath.push('');
  }

  var isAbsolute = srcPath[0] === '' ||
      (srcPath[0] && srcPath[0].charAt(0) === '/');

  // put the host back
  if (psychotic) {
    source.hostname = source.host = isAbsolute ? '' :
                                    srcPath.length ? srcPath.shift() : '';
    //occationaly the auth can get stuck only in host
    //this especialy happens in cases like
    //url.resolveObject('mailto:local1@domain1', 'local2@domain2')
    var authInHost = source.host && arrayIndexOf(source.host, '@') > 0 ?
                     source.host.split('@') : false;
    if (authInHost) {
      source.auth = authInHost.shift();
      source.host = source.hostname = authInHost.shift();
    }
  }

  mustEndAbs = mustEndAbs || (source.host && srcPath.length);

  if (mustEndAbs && !isAbsolute) {
    srcPath.unshift('');
  }

  source.pathname = srcPath.join('/');
  //to support request.http
  if (source.pathname !== undefined || source.search !== undefined) {
    source.path = (source.pathname ? source.pathname : '') +
                  (source.search ? source.search : '');
  }
  source.auth = relative.auth || source.auth;
  source.slashes = source.slashes || relative.slashes;
  source.href = urlFormat(source);
  return source;
}

function parseHost(host) {
  var out = {};
  var port = portPattern.exec(host);
  if (port) {
    port = port[0];
    out.port = port.substr(1);
    host = host.substr(0, host.length - port.length);
  }
  if (host) out.hostname = host;
  return out;
}

});

require.define("querystring",function(require,module,exports,__dirname,__filename,process,global){var isArray = typeof Array.isArray === 'function'
    ? Array.isArray
    : function (xs) {
        return Object.prototype.toString.call(xs) === '[object Array]'
    };

var objectKeys = Object.keys || function objectKeys(object) {
    if (object !== Object(object)) throw new TypeError('Invalid object');
    var keys = [];
    for (var key in object) if (object.hasOwnProperty(key)) keys[keys.length] = key;
    return keys;
}


/*!
 * querystring
 * Copyright(c) 2010 TJ Holowaychuk <tj@vision-media.ca>
 * MIT Licensed
 */

/**
 * Library version.
 */

exports.version = '0.3.1';

/**
 * Object#toString() ref for stringify().
 */

var toString = Object.prototype.toString;

/**
 * Cache non-integer test regexp.
 */

var notint = /[^0-9]/;

/**
 * Parse the given query `str`, returning an object.
 *
 * @param {String} str
 * @return {Object}
 * @api public
 */

exports.parse = function(str){
  if (null == str || '' == str) return {};

  function promote(parent, key) {
    if (parent[key].length == 0) return parent[key] = {};
    var t = {};
    for (var i in parent[key]) t[i] = parent[key][i];
    parent[key] = t;
    return t;
  }

  return String(str)
    .split('&')
    .reduce(function(ret, pair){
      try{ 
        pair = decodeURIComponent(pair.replace(/\+/g, ' '));
      } catch(e) {
        // ignore
      }

      var eql = pair.indexOf('=')
        , brace = lastBraceInKey(pair)
        , key = pair.substr(0, brace || eql)
        , val = pair.substr(brace || eql, pair.length)
        , val = val.substr(val.indexOf('=') + 1, val.length)
        , parent = ret;

      // ?foo
      if ('' == key) key = pair, val = '';

      // nested
      if (~key.indexOf(']')) {
        var parts = key.split('[')
          , len = parts.length
          , last = len - 1;

        function parse(parts, parent, key) {
          var part = parts.shift();

          // end
          if (!part) {
            if (isArray(parent[key])) {
              parent[key].push(val);
            } else if ('object' == typeof parent[key]) {
              parent[key] = val;
            } else if ('undefined' == typeof parent[key]) {
              parent[key] = val;
            } else {
              parent[key] = [parent[key], val];
            }
          // array
          } else {
            obj = parent[key] = parent[key] || [];
            if (']' == part) {
              if (isArray(obj)) {
                if ('' != val) obj.push(val);
              } else if ('object' == typeof obj) {
                obj[objectKeys(obj).length] = val;
              } else {
                obj = parent[key] = [parent[key], val];
              }
            // prop
            } else if (~part.indexOf(']')) {
              part = part.substr(0, part.length - 1);
              if(notint.test(part) && isArray(obj)) obj = promote(parent, key);
              parse(parts, obj, part);
            // key
            } else {
              if(notint.test(part) && isArray(obj)) obj = promote(parent, key);
              parse(parts, obj, part);
            }
          }
        }

        parse(parts, parent, 'base');
      // optimize
      } else {
        if (notint.test(key) && isArray(parent.base)) {
          var t = {};
          for(var k in parent.base) t[k] = parent.base[k];
          parent.base = t;
        }
        set(parent.base, key, val);
      }

      return ret;
    }, {base: {}}).base;
};

/**
 * Turn the given `obj` into a query string
 *
 * @param {Object} obj
 * @return {String}
 * @api public
 */

var stringify = exports.stringify = function(obj, prefix) {
  if (isArray(obj)) {
    return stringifyArray(obj, prefix);
  } else if ('[object Object]' == toString.call(obj)) {
    return stringifyObject(obj, prefix);
  } else if ('string' == typeof obj) {
    return stringifyString(obj, prefix);
  } else {
    return prefix;
  }
};

/**
 * Stringify the given `str`.
 *
 * @param {String} str
 * @param {String} prefix
 * @return {String}
 * @api private
 */

function stringifyString(str, prefix) {
  if (!prefix) throw new TypeError('stringify expects an object');
  return prefix + '=' + encodeURIComponent(str);
}

/**
 * Stringify the given `arr`.
 *
 * @param {Array} arr
 * @param {String} prefix
 * @return {String}
 * @api private
 */

function stringifyArray(arr, prefix) {
  var ret = [];
  if (!prefix) throw new TypeError('stringify expects an object');
  for (var i = 0; i < arr.length; i++) {
    ret.push(stringify(arr[i], prefix + '[]'));
  }
  return ret.join('&');
}

/**
 * Stringify the given `obj`.
 *
 * @param {Object} obj
 * @param {String} prefix
 * @return {String}
 * @api private
 */

function stringifyObject(obj, prefix) {
  var ret = []
    , keys = objectKeys(obj)
    , key;
  for (var i = 0, len = keys.length; i < len; ++i) {
    key = keys[i];
    ret.push(stringify(obj[key], prefix
      ? prefix + '[' + encodeURIComponent(key) + ']'
      : encodeURIComponent(key)));
  }
  return ret.join('&');
}

/**
 * Set `obj`'s `key` to `val` respecting
 * the weird and wonderful syntax of a qs,
 * where "foo=bar&foo=baz" becomes an array.
 *
 * @param {Object} obj
 * @param {String} key
 * @param {String} val
 * @api private
 */

function set(obj, key, val) {
  var v = obj[key];
  if (undefined === v) {
    obj[key] = val;
  } else if (isArray(v)) {
    v.push(val);
  } else {
    obj[key] = [v, val];
  }
}

/**
 * Locate last brace in `str` within the key.
 *
 * @param {String} str
 * @return {Number}
 * @api private
 */

function lastBraceInKey(str) {
  var len = str.length
    , brace
    , c;
  for (var i = 0; i < len; ++i) {
    c = str[i];
    if (']' == c) brace = false;
    if ('[' == c) brace = true;
    if ('=' == c && !brace) return i;
  }
}

});

require.define("http",function(require,module,exports,__dirname,__filename,process,global){module.exports = require("http-browserify")
});

require.define("/node_modules/browserify/node_modules/http-browserify/package.json",function(require,module,exports,__dirname,__filename,process,global){module.exports = {"main":"index.js","browserify":"index.js"}
});

require.define("/node_modules/browserify/node_modules/http-browserify/index.js",function(require,module,exports,__dirname,__filename,process,global){var http = module.exports;
var EventEmitter = require('events').EventEmitter;
var Request = require('./lib/request');

http.request = function (params, cb) {
    if (!params) params = {};
    if (!params.host) params.host = window.location.host.split(':')[0];
    if (!params.port) params.port = window.location.port;
    
    var req = new Request(new xhrHttp, params);
    if (cb) req.on('response', cb);
    return req;
};

http.get = function (params, cb) {
    params.method = 'GET';
    var req = http.request(params, cb);
    req.end();
    return req;
};

http.Agent = function () {};
http.Agent.defaultMaxSockets = 4;

var xhrHttp = (function () {
    if (typeof window === 'undefined') {
        throw new Error('no window object present');
    }
    else if (window.XMLHttpRequest) {
        return window.XMLHttpRequest;
    }
    else if (window.ActiveXObject) {
        var axs = [
            'Msxml2.XMLHTTP.6.0',
            'Msxml2.XMLHTTP.3.0',
            'Microsoft.XMLHTTP'
        ];
        for (var i = 0; i < axs.length; i++) {
            try {
                var ax = new(window.ActiveXObject)(axs[i]);
                return function () {
                    if (ax) {
                        var ax_ = ax;
                        ax = null;
                        return ax_;
                    }
                    else {
                        return new(window.ActiveXObject)(axs[i]);
                    }
                };
            }
            catch (e) {}
        }
        throw new Error('ajax not supported in this browser')
    }
    else {
        throw new Error('ajax not supported in this browser');
    }
})();

});

require.define("/node_modules/browserify/node_modules/http-browserify/lib/request.js",function(require,module,exports,__dirname,__filename,process,global){var Stream = require('stream');
var Response = require('./response');
var concatStream = require('concat-stream')

var Request = module.exports = function (xhr, params) {
    var self = this;
    self.writable = true;
    self.xhr = xhr;
    self.body = concatStream()
    
    var uri = params.host + ':' + params.port + (params.path || '/');
    
    xhr.open(
        params.method || 'GET',
        (params.scheme || 'http') + '://' + uri,
        true
    );
    
    if (params.headers) {
        Object.keys(params.headers).forEach(function (key) {
            if (!self.isSafeRequestHeader(key)) return;
            var value = params.headers[key];
            if (Array.isArray(value)) {
                value.forEach(function (v) {
                    xhr.setRequestHeader(key, v);
                });
            }
            else xhr.setRequestHeader(key, value)
        });
    }
    
    var res = new Response;
    res.on('ready', function () {
        self.emit('response', res);
    });
    
    xhr.onreadystatechange = function () {
        res.handle(xhr);
    };
};

Request.prototype = new Stream;

Request.prototype.setHeader = function (key, value) {
    if ((Array.isArray && Array.isArray(value))
    || value instanceof Array) {
        for (var i = 0; i < value.length; i++) {
            this.xhr.setRequestHeader(key, value[i]);
        }
    }
    else {
        this.xhr.setRequestHeader(key, value);
    }
};

Request.prototype.write = function (s) {
    this.body.write(s);
};

Request.prototype.end = function (s) {
    if (s !== undefined) this.body.write(s);
    this.body.end()
    this.xhr.send(this.body.getBody());
};

// Taken from http://dxr.mozilla.org/mozilla/mozilla-central/content/base/src/nsXMLHttpRequest.cpp.html
Request.unsafeHeaders = [
    "accept-charset",
    "accept-encoding",
    "access-control-request-headers",
    "access-control-request-method",
    "connection",
    "content-length",
    "cookie",
    "cookie2",
    "content-transfer-encoding",
    "date",
    "expect",
    "host",
    "keep-alive",
    "origin",
    "referer",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "user-agent",
    "via"
];

Request.prototype.isSafeRequestHeader = function (headerName) {
    if (!headerName) return false;
    return (Request.unsafeHeaders.indexOf(headerName.toLowerCase()) === -1)
};

});

require.define("/node_modules/browserify/node_modules/http-browserify/lib/response.js",function(require,module,exports,__dirname,__filename,process,global){var Stream = require('stream');

var Response = module.exports = function (res) {
    this.offset = 0;
    this.readable = true;
};

Response.prototype = new Stream;

var capable = {
    streaming : true,
    status2 : true
};

function parseHeaders (res) {
    var lines = res.getAllResponseHeaders().split(/\r?\n/);
    var headers = {};
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (line === '') continue;
        
        var m = line.match(/^([^:]+):\s*(.*)/);
        if (m) {
            var key = m[1].toLowerCase(), value = m[2];
            
            if (headers[key] !== undefined) {
                if ((Array.isArray && Array.isArray(headers[key]))
                || headers[key] instanceof Array) {
                    headers[key].push(value);
                }
                else {
                    headers[key] = [ headers[key], value ];
                }
            }
            else {
                headers[key] = value;
            }
        }
        else {
            headers[line] = true;
        }
    }
    return headers;
}

Response.prototype.getResponse = function (xhr) {
    var respType = xhr.responseType.toLowerCase();
    if (respType === "blob") return xhr.responseBlob;
    if (respType === "arraybuffer") return xhr.response;
    return xhr.responseText;
}

Response.prototype.getHeader = function (key) {
    return this.headers[key.toLowerCase()];
};

Response.prototype.handle = function (res) {
    if (res.readyState === 2 && capable.status2) {
        try {
            this.statusCode = res.status;
            this.headers = parseHeaders(res);
        }
        catch (err) {
            capable.status2 = false;
        }
        
        if (capable.status2) {
            this.emit('ready');
        }
    }
    else if (capable.streaming && res.readyState === 3) {
        try {
            if (!this.statusCode) {
                this.statusCode = res.status;
                this.headers = parseHeaders(res);
                this.emit('ready');
            }
        }
        catch (err) {}
        
        try {
            this.write(res);
        }
        catch (err) {
            capable.streaming = false;
        }
    }
    else if (res.readyState === 4) {
        if (!this.statusCode) {
            this.statusCode = res.status;
            this.emit('ready');
        }
        this.write(res);
        
        if (res.error) {
            this.emit('error', this.getResponse(res));
        }
        else this.emit('end');
    }
};

Response.prototype.write = function (res) {
    var respBody = this.getResponse(res);
    if (respBody.toString().match(/ArrayBuffer/)) {
        this.emit('data', new Uint8Array(respBody, this.offset));
        this.offset = respBody.byteLength;
        return;
    }
    if (respBody.length > this.offset) {
        this.emit('data', respBody.slice(this.offset));
        this.offset = respBody.length;
    }
};

});

require.define("/node_modules/browserify/node_modules/http-browserify/node_modules/concat-stream/package.json",function(require,module,exports,__dirname,__filename,process,global){module.exports = {}
});

require.define("/node_modules/browserify/node_modules/http-browserify/node_modules/concat-stream/index.js",function(require,module,exports,__dirname,__filename,process,global){var stream = require('stream')
var util = require('util')

function ConcatStream(cb) {
  stream.Stream.call(this)
  this.writable = true
  if (cb) this.cb = cb
  this.body = []
  if (this.cb) this.on('error', cb)
}

util.inherits(ConcatStream, stream.Stream)

ConcatStream.prototype.write = function(chunk) {
  this.body.push(chunk)
}

ConcatStream.prototype.arrayConcat = function(arrs) {
  if (arrs.length === 0) return []
  if (arrs.length === 1) return arrs[0]
  return arrs.reduce(function (a, b) { return a.concat(b) })
}

ConcatStream.prototype.isArray = function(arr) {
  var isArray = Array.isArray(arr)
  var isTypedArray = arr.toString().match(/Array/)
  return isArray || isTypedArray
}

ConcatStream.prototype.getBody = function () {
  if (this.body.length === 0) return
  if (typeof(this.body[0]) === "string") return this.body.join('')
  if (this.isArray(this.body[0])) return this.arrayConcat(this.body)
  if (typeof(Buffer) !== "undefined" && Buffer.isBuffer(this.body[0])) {
    return Buffer.concat(this.body)
  }
  return this.body
}

ConcatStream.prototype.end = function() {
  if (this.cb) this.cb(false, this.getBody())
}

module.exports = function(cb) {
  return new ConcatStream(cb)
}

module.exports.ConcatStream = ConcatStream

});

require.define("https",function(require,module,exports,__dirname,__filename,process,global){module.exports = require('http');

});

require.define("/v1sdk.coffee",function(require,module,exports,__dirname,__filename,process,global){(function() {
  var V1Meta, V1Server;

  V1Meta = require('./v1meta').V1Meta;

  V1Server = require('./client').V1Server;

}).call(this);

});
require("/v1sdk.coffee");
})();
