'use strict';

/**
 * @fileOverview Hash Array Mapped Trie.
 * 
 * Code based on: https://github.com/exclipy/pdata
*/
var hamt = {};

var constant = function constant(x) {
    return function () {
        return x;
    };
};

/* Configuration
 ******************************************************************************/
var SIZE = 5;

var BUCKET_SIZE = Math.pow(2, SIZE);

var MASK = BUCKET_SIZE - 1;

var MAX_INDEX_NODE = BUCKET_SIZE / 2;

var MIN_ARRAY_NODE = BUCKET_SIZE / 4;

/* Nothing
 ******************************************************************************/
var nothing = { __hamt_nothing: true };

var isNothing = function isNothing(x) {
    return x === nothing || x && x.__hamt_nothing;
};

var maybe = function maybe(val, def) {
    return isNothing(val) ? def : val;
};

/* Bit Ops
 ******************************************************************************/
/**
 * Hamming weight.
 * 
 * Taken from: http://jsperf.com/hamming-weight
*/
var popcount = function popcount(x) {
    x -= x >> 1 & 0x55555555;
    x = (x & 0x33333333) + (x >> 2 & 0x33333333);
    x = x + (x >> 4) & 0x0f0f0f0f;
    x += x >> 8;
    x += x >> 16;
    return x & 0x7f;
};

var hashFragment = function hashFragment(shift, h) {
    return h >>> shift & MASK;
};

var toBitmap = function toBitmap(x) {
    return 1 << x;
};

var fromBitmap = function fromBitmap(bitmap, bit) {
    return popcount(bitmap & bit - 1);
};

/* Array Ops
 ******************************************************************************/
/**
 * Set a value in an array.
 * 
 * @param at Index to change.
 * @param v New value
 * @param arr Array.
*/
var arrayUpdate = function arrayUpdate(at, v, arr) {
    var len = arr.length;
    var out = new Array(len);
    for (var i = 0; i < len; ++i) {
        out[i] = arr[i];
    }out[at] = v;
    return out;
};

/**
 * Remove a value from an array.
 * 
 * @param at Index to remove.
 * @param arr Array.
*/
var arraySpliceOut = function arraySpliceOut(at, arr) {
    var len = arr.length;
    var out = new Array(len - 1);
    var i = 0,
        g = 0;
    while (i < at) {
        out[g++] = arr[i++];
    }++i;
    while (i < len) {
        out[g++] = arr[i++];
    }return out;
};

/**
 * Insert a value into an array.
 * 
 * @param at Index to insert at.
 * @param v Value to insert,
 * @param arr Array.
*/
var arraySpliceIn = function arraySpliceIn(at, v, arr) {
    var len = arr.length;
    var out = new Array(len + 1);
    var i = 0;
    var g = 0;
    while (i < at) {
        out[g++] = arr[i++];
    }out[g++] = v;
    while (i < len) {
        out[g++] = arr[i++];
    }return out;
};

/* 
 ******************************************************************************/
/**
 * Get 32 bit hash of string.
 * 
 * Based on:
 * http://stackoverflow.com/questions/7616461/generate-a-hash-from-string-in-javascript-jquery
*/
var hash = hamt.hash = function (str) {
    if (typeof str === 'number') return str;

    var hash = 0;
    for (var i = 0, len = str.length; i < len; ++i) {
        var c = str.charCodeAt(i);
        hash = (hash << 5) - hash + c | 0;
    }
    return hash;
};

/* Node Structures
 ******************************************************************************/
var Node = function Node() {};

/**
 * Empty node.
*/
var empty = hamt.empty = new Node();
empty.__hamt_isEmpty = true;

/**
 * Leaf holding a value.
 * 
 * @member hash Hash of key.
 * @member key Key.
 * @member value Value stored.
*/
var Leaf = function Leaf(hash, key, value) {
    this.hash = hash;
    this.key = key;
    this.value = value;
};
Leaf.prototype = new Node();

/**
 * Leaf holding multiple values with the same hash but different keys.
 * 
 * @member hash Hash of key.
 * @member children Array of collision children node.
*/
var Collision = function Collision(hash, children) {
    this.hash = hash;
    this.children = children;
};
Collision.prototype = new Node();

/**
 * Internal node with a sparse set of children.
 * 
 * Uses a bitmap and array to pack children.
 * 
 * @member mask Bitmap that encode the positions of children in the array.
 * @member children Array of child nodes.
*/
var IndexedNode = function IndexedNode(mask, children) {
    this.mask = mask;
    this.children = children;
};
IndexedNode.prototype = new Node();

/**
 * Internal node with many children.
 * 
 * @member count Number of children.
 * @member children Array of child nodes.
*/
var ArrayNode = function ArrayNode(count, children) {
    this.count = count;
    this.children = children;
};
ArrayNode.prototype = new Node();

/* 
 ******************************************************************************/
var isEmpty = function isEmpty(x) {
    return !x || x === empty || x && x.__hamt_isEmpty;
};

/**
 * Is `node` a leaf node?
*/
var isLeaf = function isLeaf(node) {
    return node === empty || node instanceof Leaf || node instanceof Collision;
};

/**
 * Expand an indexed node into an array node.
 * 
 * @param frag Index of added child.
 * @param child Added child.
 * @param mask Index node mask before child added.
 * @param subNodes Index node children before child added.
*/
var expand = function expand(frag, child, bitmap, subNodes) {
    var arr = [];

    var bit = bitmap;
    var count = 0;
    for (var i = 0; bit; ++i) {
        if (bit & 1) arr[i] = subNodes[count++];
        bit >>>= 1;
    }
    arr[frag] = child;
    return new ArrayNode(count + 1, arr);
};

/**
 * Collapse an array node into a indexed node.
*/
var pack = function pack(count, removed, elements) {
    var children = new Array(count - 1);
    var g = 0;
    var bitmap = 0;
    for (var i = 0, len = elements.length; i < len; ++i) {
        var elem = elements[i];
        if (i !== removed && !isEmpty(elem)) {
            children[g++] = elem;
            bitmap |= 1 << i;
        }
    }
    return new IndexedNode(bitmap, children);
};

/**
 * Merge two leaf nodes.
 * 
 * @param shift Current shift.
 * @param h1 Node 1 hash.
 * @param n1 Node 1.
 * @param h2 Node 2 hash.
 * @param n2 Node 2.
*/
var mergeLeaves = function mergeLeaves(shift, h1, n1, h2, n2) {
    if (h1 === h2) return new Collision(h1, [n2, n1]);

    var subH1 = hashFragment(shift, h1);
    var subH2 = hashFragment(shift, h2);
    return new IndexedNode(toBitmap(subH1) | toBitmap(subH2), subH1 === subH2 ? [mergeLeaves(shift + SIZE, h1, n1, h2, n2)] : subH1 < subH2 ? [n1, n2] : [n2, n1]);
};

/**
 * Update an entry in a collision list.
 * 
 * @param hash Hash of collision.
 * @param list Collision list.
 * @param f Update function.
 * @param k Key to update.
*/
var updateCollisionList = function updateCollisionList(h, list, f, k) {
    var target = undefined;
    var i = 0;
    for (var len = list.length; i < len; ++i) {
        var child = list[i];
        if (child.key === k) {
            target = child;
            break;
        }
    }

    var v = target ? f(target.value) : f();
    return isNothing(v) ? arraySpliceOut(i, list) : arrayUpdate(i, new Leaf(h, k, v), list);
};

/* Lookups
 ******************************************************************************/
/**
 * Leaf::get
*/
Leaf.prototype._lookup = function (_, h, k) {
    return k === this.key ? this.value : nothing;
};

/**
 * Collision::get
*/
Collision.prototype._lookup = function (_, h, k) {
    if (h === this.hash) {
        var children = this.children;
        for (var i = 0, len = children.length; i < len; ++i) {
            var child = children[i];
            if (k === child.key) return child.value;
        }
    }
    return nothing;
};

/**
 * IndexedNode::get
*/
IndexedNode.prototype._lookup = function (shift, h, k) {
    var frag = hashFragment(shift, h);
    var bit = toBitmap(frag);
    return this.mask & bit ? this.children[fromBitmap(this.mask, bit)]._lookup(shift + SIZE, h, k) : nothing;
};

/**
 * ArrayNode::get
*/
ArrayNode.prototype._lookup = function (shift, h, k) {
    var frag = hashFragment(shift, h);
    var child = this.children[frag];
    return child._lookup(shift + SIZE, h, k);
};

empty._lookup = function () {
    return nothing;
};

/* Editing
 ******************************************************************************/
Leaf.prototype._modify = function (shift, f, h, k) {
    if (k === this.key) {
        var _v = f(this.value);
        return isNothing(_v) ? empty : new Leaf(h, k, _v);
    }
    var v = f();
    return isNothing(v) ? this : mergeLeaves(shift, this.hash, this, h, new Leaf(h, k, v));
};

Collision.prototype._modify = function (shift, f, h, k) {
    if (h === this.hash) {
        var list = updateCollisionList(this.hash, this.children, f, k);
        return list.length > 1 ? new Collision(this.hash, list) : list[0]; // collapse single element collision list
    }
    var v = f();
    return isNothing(v) ? this : mergeLeaves(shift, this.hash, this, h, new Leaf(h, k, v));
};

IndexedNode.prototype._modify = function (shift, f, h, k) {
    var mask = this.mask;
    var children = this.children;
    var frag = hashFragment(shift, h);
    var bit = toBitmap(frag);
    var indx = fromBitmap(mask, bit);
    var exists = mask & bit;
    var current = exists ? children[indx] : empty;
    var child = current._modify(shift + SIZE, f, h, k);

    if (exists && isEmpty(child)) {
        // remove
        var bitmap = mask & ~bit;
        if (!bitmap) return empty;
        return children.length <= 2 && isLeaf(children[indx ^ 1]) ? children[indx ^ 1] // collapse
        : new IndexedNode(bitmap, arraySpliceOut(indx, children));
    }
    if (!exists && !isEmpty(child)) {
        // add
        return children.length >= MAX_INDEX_NODE ? expand(frag, child, mask, children) : new IndexedNode(mask | bit, arraySpliceIn(indx, child, children));
    }

    // modify
    return current === child ? this : new IndexedNode(mask, arrayUpdate(indx, child, children));
};

ArrayNode.prototype._modify = function (shift, f, h, k) {
    var count = this.count;
    var children = this.children;
    var frag = hashFragment(shift, h);
    var child = children[frag];
    var newChild = (child || empty)._modify(shift + SIZE, f, h, k);

    if (isEmpty(child) && !isEmpty(newChild)) {
        // add
        return new ArrayNode(count + 1, arrayUpdate(frag, newChild, children));
    }
    if (!isEmpty(child) && isEmpty(newChild)) {
        // remove
        return count - 1 <= MIN_ARRAY_NODE ? pack(count, frag, children) : new ArrayNode(count - 1, arrayUpdate(frag, empty, children));
    }

    // modify
    return child === newChild ? this : new ArrayNode(count, arrayUpdate(frag, newChild, children));
};

empty._modify = function (_, f, h, k) {
    var v = f();
    return isNothing(v) ? empty : new Leaf(h, k, v);
};

/* Queries
 ******************************************************************************/
/**
    Lookup the value for `key` in `map`.
    
    Returns the value or `alt` if none.
*/
var tryGet = hamt.tryGet = function (alt, key, map) {
    return maybe(map._lookup(0, hash(key), key), alt);
};

Node.prototype.tryGet = function (key, alt) {
    return tryGet(alt, key, this);
};

/**
    Lookup the value for `key` in `map`.
    
    Returns the value or `undefined` if none.
*/
var get = hamt.get = function (key, map) {
    return tryGet(undefined, key, map);
};

Node.prototype.get = function (key, alt) {
    return tryGet(alt, key, this);
};

/**
    Does an entry exist for `key` in `map`?
*/
var has = hamt.has = function (key, map) {
    return !isNothing(tryGet(nothing, key, map));
};

Node.prototype.has = function (key) {
    return has(key, this);
};

/* Updates
 ******************************************************************************/
/**
    Alter the value stored for `key` in `map` using function `f`.
    
    `f` is invoked with the current value for `k` if it exists,
    or no arguments if no such value exists. `modify` will always either
    update or insert a value into the map.
    
    Returns a map with the modified value. Does not alter `map`.
*/
var modify = hamt.modify = function (f, key, map) {
    return map._modify(0, f, hash(key), key);
};

Node.prototype.modify = function (key, f) {
    return modify(f, key, this);
};

/**
    Store `value` for `key` in `map`.

    Returns a map with the modified value. Does not alter `map`.
*/
var set = hamt.set = function (value, key, map) {
    return modify(constant(value), key, map);
};

Node.prototype.set = function (key, value) {
    return set(value, key, this);
};

/**
    Remove the entry for `key` in `map`.

    Returns a map with the value removed. Does not alter `map`.
*/
var del = constant(nothing);
var remove = hamt.remove = function (key, map) {
    return modify(del, key, map);
};

Node.prototype.remove = function (key) {
    return remove(key, this);
};

/* Fold
 ******************************************************************************/
Leaf.prototype.fold = function (f, z) {
    return f(z, this);
};

Collision.prototype.fold = function (f, z) {
    return this.children.reduce(f, z);
};

IndexedNode.prototype.fold = function (f, z) {
    var children = this.children;
    for (var i = 0, len = children.length; i < len; ++i) {
        var c = children[i];
        z = c instanceof Leaf ? f(z, c) : c.fold(f, z);
    }
    return z;
};

ArrayNode.prototype.fold = function (f, z) {
    var children = this.children;
    for (var i = 0, len = children.length; i < len; ++i) {
        var c = children[i];
        if (!isEmpty(c)) z = c instanceof Leaf ? f(z, c) : c.fold(f, z);
    }
    return z;
};

/**
    Visit every entry in the map, aggregating data.

    Order of nodes is not guaranteed.
    
    @param f Function mapping previous value and key value object to new value.
    @param z Starting value.
    @param m HAMT
*/
var fold = hamt.fold = function (f, z, m) {
    return isEmpty(m) ? z : m.fold(f, z);
};

Node.prototype.fold = function (f, z) {
    return fold(f, z, this);
};

/* Aggregate
 ******************************************************************************/
/**
    Get the number of entries in `map`.
*/
var inc = function inc(x) {
    return x + 1;
};
var count = hamt.count = function (map) {
    return fold(inc, 0, map);
};

Node.prototype.count = function () {
    return count(this);
};

/**
    Get array of all key value pairs as arrays of [key, value] in `map`.
 
    Order is not guaranteed.
*/
var buildPairs = function buildPairs(p, x) {
    p.push(x);return p;
};
var pairs = hamt.pairs = function (map) {
    return fold(buildPairs, [], m);
};

Node.prototype.pairs = function () {
    return count(this);
};

/**
    Get array of all keys in `map`.

    Order is not guaranteed.
*/
var buildKeys = function buildKeys(p, x) {
    p.push(x.key);return p;
};
var keys = hamt.keys = function (m) {
    return fold(buildKeys, [], m);
};

Node.prototype.keys = function () {
    return keys(this);
};

/**
    Get array of all values in `map`.

    Order is not guaranteed, duplicates are preserved.
*/
var buildValues = function buildValues(p, x) {
    p.push(x.value);return p;
};
var values = hamt.values = function (m) {
    return fold(buildValues, [], m);
};

Node.prototype.values = function () {
    return values(this);
};

/* Export
 ******************************************************************************/
if (typeof module !== 'undefined' && module.exports) {
    module.exports = hamt;
} else if (typeof define === 'function' && define.amd) {
    define('hamt', [], function () {
        return hamt;
    });
} else {
    undefined.hamt = hamt;
}
//# sourceMappingURL=hamt.js.map
