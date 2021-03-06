

var clone = require('clone');
var defaults = require('defaults');
var LRU = require('lru-cache');
var ms = require('ms');
var tick = setImmediate || process.nextTick;

/**
 * Expose `ProxyCache`.
 */

module.exports = ProxyCache;

/**
 * Default metrics collector.
 */

ProxyCache.stats = {
  gauge: function(){},
  incr: function(){},
  timer: function(){},
};

/**
 * A proxying cache.
 *
 * @param {Object} instance
 * @param {object} methods
 * @param {object} options
 *  @param {Object} stats
 *  @param {Number} max
 *  @param {Number} maxAge
 *  @param {Boolean} stale
 *  @param {Boolean} peek
 *  @param {Boolean} tombstone  cache undefined values as well
 */

function ProxyCache (instance, methods, options) {
  if (!(this instanceof ProxyCache)) return new ProxyCache(instance, methods, options);
  if (typeof instance !== 'object') throw new TypeError('Instance must be an object.');
  if (!(methods instanceof Array)) throw new TypeError('Methods must be an array.');

  this.options = defaults(options, {
    max: 10000,
    maxAge: ms('1m'),
    stale: false,
    peek: true, // peek by default so maxAge is honored.
    tombstone: true,
    stats: ProxyCache.stats
  });

  this.stats = this.options.stats;
  this.parent = instance;
  this.cache = new LRU(this.options);

  for (var prop in instance) this[prop] = this._proxy(instance, prop);
  for (var i = 0; i < methods.length; i++) {
    var method = methods[i];
    this[method] = this._wrap(instance, method);
  }
}

/**
 * Proxy the instance's `key` property to this cache.
 *
 * @param {Object} instance
 * @param {String} key
 * @return {Function|?}
 */

ProxyCache.prototype._proxy = function (instance, key) {
  if (typeof instance[key] !== 'function') return instance[key];
  return function () {
    return instance[key].apply(instance, arguments);
  };
};


/**
 * Wrap the instance's `method` with a middle layer that
 * caches results.
 *
 * @param {Object} instance
 * @param {String} method
 * @returns {Function}
 */

ProxyCache.prototype._wrap = function (instance, method) {
  if (typeof instance[method] !== 'function') throw new TypeError('Can only cache methods!');
  var self = this;
  var tombstone = this.options.tombstone;
  var inFlight = {};

  return function () {
    var callback = arguments[arguments.length - 1];
    var args = [].slice.call(arguments, 0, arguments.length-1);
    var key = self._key(method, args);
    var tags = ['method:' + method];
    var start = new Date;

    self.stats.incr('proxy-cache.calls', 1, tags);
    self.stats.gauge('proxy-cache.size', self.cache.length, tags);

    if (self._has(key)) {
      self.stats.incr('proxy-cache.hit', 1, tags);
      var cached = self._get(key);
      return tick(function(){ callback(null, cached); });
    };

    // in-flight callback.
    if (inFlight[key]) {
      inFlight[key].push(callback);
      return;
    }

    // queue initial callback.
    inFlight[key] = [callback];

    // we didn't find it in the cache, let's push our wrapped
    args.push(function (err, result) {
      self.stats.timer('proxy-cache.duration', new Date - start, tags);
      if (err) return done(err);
      var present = result != undefined;
      if (present || tombstone) self.cache.set(key, result);
      done(null, result);
    });

    // call all callbacks.
    function done(err, result){
      var fns = inFlight[key];

      if (err) {
        fns.forEach(function(fn){
          fn(err);
        });
      } else {
        fns.forEach(function(fn){
          fn(null, result);
        });
      }

      inFlight[key] = null;
    }

    self.stats.incr('proxy-cache.miss', 1, tags);
    // proxy the query to the instance
    return instance[method].apply(instance, args);
  };
};

/**
 * Generate a cache key.
 * @param {String} method
 * @param {Array} args
 * @returns {String}
 */

ProxyCache.prototype._key = function (method, args) {
  return [method].concat(args).join(':');
};

/**
 * Get or peek into the cache with the provided `key`.
 * @param  {key} type
 * @returns {Object}
 */

ProxyCache.prototype._get = function (key) {
  var cache = this.cache;
  var get = this.options.peek
    ? cache.peek
    : cache.get;

  return clone(get.call(cache, key), true, 1);
};

/**
 * See whether we have `key` in our cache.
 * @param  {key} type
 * @returns {Object}
 */

ProxyCache.prototype._has = function (key) {
  return this.cache.has(key);
};
