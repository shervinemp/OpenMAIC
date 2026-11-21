import { createContext, Script, type Context } from 'node:vm';
import { parse, type DefaultTreeAdapterTypes } from 'parse5';

export interface WidgetVariableClaim {
  name: string;
  min: number;
  max: number;
  default?: number;
}

export interface WidgetPresetClaim {
  name: string;
  variables: Record<string, number>;
}

export interface WidgetProbeOptions {
  variables: WidgetVariableClaim[];
  presets: WidgetPresetClaim[];
}

export interface WidgetProbeSnapshot {
  label: string;
  values: Record<string, number>;
  published: Record<string, unknown> | null;
  visibleText: Record<string, string>;
}

export interface WidgetProbeResult {
  snapshots: WidgetProbeSnapshot[];
  errors: string[];
}

/**
 * Classic script type essences. Empty means the type attribute was omitted.
 * Kept in sync with `interactive-script-validator.ts` so the sandbox executes
 * exactly the scripts the rest of the pipeline considers executable.
 */
const CLASSIC_JAVASCRIPT_TYPES = new Set([
  '',
  'application/ecmascript',
  'application/javascript',
  'application/x-ecmascript',
  'application/x-javascript',
  'text/ecmascript',
  'text/javascript',
  'text/javascript1.0',
  'text/javascript1.1',
  'text/javascript1.2',
  'text/javascript1.3',
  'text/javascript1.4',
  'text/javascript1.5',
  'text/jscript',
  'text/livescript',
  'text/x-ecmascript',
  'text/x-javascript',
]);

const MAX_SNAPSHOTS = 50;
const MAX_OBSERVATION_BYTES = 64 * 1024;
const INIT_TIMEOUT_MS = 2000;
const PROBE_TIMEOUT_MS = 1000;

/**
 * The bootstrap runs *inside* the vm context. Keeping every DOM stub, timer,
 * and helper function vm-native avoids handing host objects (and their
 * `constructor.constructor`) to untrusted widget code, which is the usual way
 * a `node:vm` sandbox escapes into `process`/`require`. The host only passes a
 * JSON string of element descriptors in, and reads primitive strings back out.
 */
const SANDBOX_BOOTSTRAP = String.raw`
(function () {
  'use strict';

  var noop = function () {};
  var descriptors = JSON.parse(
    globalThis.__MAIC_DOM_JSON__ || '{"tag":"#document","attrs":[],"children":[]}',
  );
  var allElements = [];

  function reflectAttr(el, prop, attr, fallback) {
    Object.defineProperty(el, prop, {
      get: function () {
        var value = el._attrs[attr];
        return value === undefined ? fallback : value;
      },
      set: function (value) {
        el._attrs[attr] = String(value);
        if (attr === 'class') el._syncClasses();
      },
      enumerable: true,
      configurable: true,
    });
  }

  function readName(source, index) {
    var start = index;
    while (index < source.length && /[A-Za-z0-9_:\-]/.test(source[index])) index += 1;
    return { name: source.slice(start, index), index: index };
  }

  function compileSelector(selector) {
    var compiled = { tag: '', ids: [], classes: [], attrs: [] };
    var source = String(selector);
    var index = 0;
    while (index < source.length) {
      var ch = source[index];
      if (ch === '#') {
        var idPart = readName(source, index + 1);
        if (idPart.name) compiled.ids.push(idPart.name);
        index = idPart.index;
      } else if (ch === '.') {
        var classPart = readName(source, index + 1);
        if (classPart.name) compiled.classes.push(classPart.name);
        index = classPart.index;
      } else if (ch === '[') {
        var end = source.indexOf(']', index + 1);
        if (end === -1) break;
        var body = source.slice(index + 1, end);
        var match = /^\s*([A-Za-z_][\w:\-]*)\s*(?:([~^$*|]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\s\]]+)))?\s*$/.exec(body);
        if (match) {
          var value = match[3] !== undefined ? match[3] : match[4] !== undefined ? match[4] : match[5];
          compiled.attrs.push({ name: match[1].toLowerCase(), op: match[2] || '', value: value });
        }
        index = end + 1;
      } else if (/[A-Za-z]/.test(ch)) {
        var tagPart = readName(source, index);
        if (tagPart.name) compiled.tag = tagPart.name.toLowerCase();
        index = tagPart.index;
      } else {
        index += 1;
      }
    }
    return compiled;
  }

  function matches(el, compiled) {
    if (compiled.tag && el.localName !== compiled.tag) return false;
    for (var i = 0; i < compiled.ids.length; i++) {
      if (el.id !== compiled.ids[i]) return false;
    }
    for (var j = 0; j < compiled.classes.length; j++) {
      if (el._classes.indexOf(compiled.classes[j]) === -1) return false;
    }
    for (var k = 0; k < compiled.attrs.length; k++) {
      var attr = compiled.attrs[k];
      var actual = el._attrs[attr.name];
      if (attr.value === undefined) {
        if (actual === undefined) return false;
      } else if (actual === undefined) {
        return false;
      } else if (attr.op === '~=') {
        if (actual.split(/\s+/).indexOf(attr.value) === -1) return false;
      } else if (actual !== attr.value) {
        return false;
      }
    }
    return true;
  }

  function queryAll(root, selector) {
    var groups = String(selector)
      .split(',')
      .map(function (part) { return part.trim(); })
      .filter(Boolean)
      .map(compileSelector);
    var out = [];
    function visit(node) {
      if (!node || node.nodeType !== 1) return;
      for (var i = 0; i < node.childNodes.length; i++) {
        var child = node.childNodes[i];
        if (child.nodeType !== 1) continue;
        for (var g = 0; g < groups.length; g++) {
          if (matches(child, groups[g])) {
            out.push(child);
            break;
          }
        }
        visit(child);
      }
    }
    visit(root);
    return out;
  }

  function TextNode(value) {
    this.nodeType = 3;
    this.nodeName = '#text';
    this.nodeValue = String(value === undefined || value === null ? '' : value);
    this.textContent = this.nodeValue;
    this.childNodes = [];
    this.parentNode = null;
  }
  TextNode.prototype.cloneNode = function () { return new TextNode(this.nodeValue); };

  function makeContext(canvas) {
    var store = { canvas: canvas };
    return new Proxy(store, {
      get: function (target, prop) {
        if (typeof prop === 'symbol') return undefined;
        if (prop in target) return target[prop];
        if (prop === 'createLinearGradient' || prop === 'createRadialGradient' || prop === 'createConicGradient') {
          return function () { return { addColorStop: noop }; };
        }
        if (prop === 'createPattern') return function () { return null; };
        if (prop === 'measureText') {
          return function (text) {
            return { width: String(text).length * 8, actualBoundingBoxLeft: 0, actualBoundingBoxRight: 0 };
          };
        }
        if (prop === 'getImageData') {
          return function (x, y, width, height) {
            return { data: new Uint8ClampedArray(Math.max(0, width * height * 4)), width: width, height: height };
          };
        }
        if (prop === 'toString') return function () { return '[object CanvasRenderingContext2D]'; };
        return noop;
      },
      set: function (target, prop, value) {
        target[prop] = value;
        return true;
      },
    });
  }

  function Element(tag, attrs) {
    this.localName = String(tag).toLowerCase();
    this.tagName = this.localName.toUpperCase();
    this.nodeName = this.tagName;
    this.nodeType = 1;
    this.childNodes = [];
    this.parentNode = null;
    var host = this;
    Object.defineProperty(this, 'parentElement', {
      get: function () {
        return host.parentNode && host.parentNode.nodeType === 1 ? host.parentNode : null;
      },
      configurable: true,
    });
    this._attrs = Object.create(null);
    this._listeners = Object.create(null);
    this._text = null;
    this._classes = [];
    this._ctx = null;
    // A plain mutable object is enough: generated widgets only assign CSS
    // properties (style.width, style.cssText, style.display, ...).
    this.style = { cssText: '', display: '', opacity: '', visibility: '' };
    var list = attrs || [];
    for (var i = 0; i < list.length; i++) {
      this._attrs[String(list[i][0]).toLowerCase()] = String(list[i][1]);
    }
    this._value = this._attrs.value === undefined ? '' : this._attrs.value;
    this._checked = this._attrs.checked !== undefined;
    this._syncClasses();

    reflectAttr(this, 'id', 'id', '');
    reflectAttr(this, 'type', 'type', '');
    reflectAttr(this, 'name', 'name', '');
    reflectAttr(this, 'title', 'title', '');
    reflectAttr(this, 'role', 'role', '');
    reflectAttr(this, 'href', 'href', '');
    reflectAttr(this, 'src', 'src', '');

    var self = this;
    Object.defineProperty(this, 'className', {
      get: function () { return self._classes.join(' '); },
      set: function (value) {
        self._attrs.class = String(value);
        self._syncClasses();
      },
      enumerable: true,
      configurable: true,
    });
    Object.defineProperty(this, 'value', {
      get: function () { return self._value; },
      set: function (value) { self._value = String(value === undefined || value === null ? '' : value); },
      enumerable: true,
      configurable: true,
    });
    Object.defineProperty(this, 'checked', {
      get: function () { return self._checked; },
      set: function (value) { self._checked = !!value; },
      enumerable: true,
      configurable: true,
    });
    Object.defineProperty(this, 'textContent', {
      get: function () {
        if (self._text !== null) return self._text;
        var text = '';
        for (var i = 0; i < self.childNodes.length; i++) {
          var child = self.childNodes[i];
          if (child.nodeType === 3) text += child.nodeValue;
          else if (child.textContent) text += child.textContent;
        }
        return text;
      },
      set: function (value) {
        self._text = String(value === undefined || value === null ? '' : value);
        self.childNodes = [];
      },
      enumerable: true,
      configurable: true,
    });
    Object.defineProperty(this, 'innerText', {
      get: function () { return self.textContent; },
      set: function (value) { self.textContent = value; },
      enumerable: true,
      configurable: true,
    });
    Object.defineProperty(this, 'innerHTML', {
      get: function () { return self.textContent; },
      set: function (value) { self.textContent = value; },
      enumerable: true,
      configurable: true,
    });
    Object.defineProperty(this, 'classList', {
      get: function () {
        return {
          length: self._classes.length,
          value: self._classes.join(' '),
          add: function () {
            for (var i = 0; i < arguments.length; i++) {
              var token = String(arguments[i]);
              if (token && self._classes.indexOf(token) === -1) self._classes.push(token);
            }
            self._writeClasses();
          },
          remove: function () {
            for (var i = 0; i < arguments.length; i++) {
              var token = String(arguments[i]);
              var at = self._classes.indexOf(token);
              if (at !== -1) self._classes.splice(at, 1);
            }
            self._writeClasses();
          },
          toggle: function (token, force) {
            var at = self._classes.indexOf(String(token));
            var shouldHave = force === undefined ? at === -1 : !!force;
            if (shouldHave && at === -1) self._classes.push(String(token));
            if (!shouldHave && at !== -1) self._classes.splice(at, 1);
            self._writeClasses();
            return shouldHave;
          },
          contains: function (token) { return self._classes.indexOf(String(token)) !== -1; },
          item: function (index) { return self._classes[index] || null; },
          forEach: function (callback) { self._classes.forEach(callback); },
          toString: function () { return self._classes.join(' '); },
        };
      },
      enumerable: true,
      configurable: true,
    });
  }

  Element.prototype._syncClasses = function () {
    var raw = this._attrs.class || '';
    this._classes = raw.split(/\s+/).filter(Boolean);
  };
  Element.prototype._writeClasses = function () {
    this._attrs.class = this._classes.join(' ');
  };
  Element.prototype.setAttribute = function (name, value) {
    var key = String(name).toLowerCase();
    this._attrs[key] = String(value);
    if (key === 'class') this._syncClasses();
    if (key === 'value') this._value = String(value);
  };
  Element.prototype.getAttribute = function (name) {
    var value = this._attrs[String(name).toLowerCase()];
    return value === undefined ? null : value;
  };
  Element.prototype.hasAttribute = function (name) {
    return this._attrs[String(name).toLowerCase()] !== undefined;
  };
  Element.prototype.removeAttribute = function (name) {
    var key = String(name).toLowerCase();
    delete this._attrs[key];
    if (key === 'class') this._syncClasses();
  };
  Element.prototype.addEventListener = function (type, listener) {
    if (typeof listener !== 'function') return;
    var key = String(type);
    (this._listeners[key] || (this._listeners[key] = [])).push(listener);
  };
  Element.prototype.removeEventListener = function (type, listener) {
    var key = String(type);
    var list = this._listeners[key];
    if (!list) return;
    var at = list.indexOf(listener);
    if (at !== -1) list.splice(at, 1);
  };
  Element.prototype.dispatchEvent = function (event) {
    if (!event || !event.type) return false;
    if (!event.target) event.target = this;
    var node = this;
    while (node) {
      var list = node._listeners && node._listeners[event.type];
      if (list) {
        var copy = list.slice();
        for (var i = 0; i < copy.length; i++) copy[i].call(node, event);
      }
      node = node.parentNode;
    }
    return true;
  };
  Element.prototype.appendChild = function (child) {
    if (!child) return child;
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    if (child.nodeType === 1 && allElements.indexOf(child) === -1) allElements.push(child);
    return child;
  };
  Element.prototype.removeChild = function (child) {
    var at = this.childNodes.indexOf(child);
    if (at !== -1) this.childNodes.splice(at, 1);
    if (child) child.parentNode = null;
    return child;
  };
  Element.prototype.insertBefore = function (child, reference) {
    if (!reference) return this.appendChild(child);
    var at = this.childNodes.indexOf(reference);
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    if (at === -1) this.childNodes.push(child);
    else this.childNodes.splice(at, 0, child);
    if (child.nodeType === 1 && allElements.indexOf(child) === -1) allElements.push(child);
    return child;
  };
  Element.prototype.remove = function () {
    if (this.parentNode) this.parentNode.removeChild(this);
  };
  Element.prototype.contains = function (other) {
    var node = other;
    while (node) {
      if (node === this) return true;
      node = node.parentNode;
    }
    return false;
  };
  Element.prototype.closest = function (selector) {
    var compiled = compileSelector(selector);
    var node = this;
    while (node && node.nodeType === 1) {
      if (matches(node, compiled)) return node;
      node = node.parentNode;
    }
    return null;
  };
  Element.prototype.querySelector = function (selector) {
    return queryAll(this, selector)[0] || null;
  };
  Element.prototype.querySelectorAll = function (selector) {
    return queryAll(this, selector);
  };
  Element.prototype.getBoundingClientRect = function () {
    return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: function () { return {}; } };
  };
  Element.prototype.getContext = function () {
    if (!this._ctx) this._ctx = makeContext(this);
    return this._ctx;
  };
  Element.prototype.focus = noop;
  Element.prototype.blur = noop;
  Element.prototype.scrollIntoView = noop;
  Element.prototype.setPointerCapture = noop;
  Element.prototype.releasePointerCapture = noop;
  Element.prototype.click = function () { this.dispatchEvent(new Event('click', { bubbles: true })); };
  Element.prototype.cloneNode = function () {
    var attrs = [];
    for (var key in this._attrs) {
      if (Object.prototype.hasOwnProperty.call(this._attrs, key)) attrs.push([key, this._attrs[key]]);
    }
    return new Element(this.localName, attrs);
  };

  function build(descriptor, parent) {
    if (!descriptor) return null;
    var node;
    if (descriptor.tag === '#text') {
      node = new TextNode(descriptor.text || '');
    } else {
      node = new Element(descriptor.tag, descriptor.attrs || []);
      allElements.push(node);
      var children = descriptor.children || [];
      for (var i = 0; i < children.length; i++) build(children[i], node);
    }
    if (parent) parent.appendChild(node);
    return node;
  }

  var root = build(descriptors, null);
  if (!root || root.nodeType !== 1) {
    root = new Element('#document', []);
  }

  var documentListeners = Object.create(null);
  var document = {
    nodeType: 9,
    nodeName: '#document',
    _listeners: documentListeners,
    childNodes: root.childNodes,
    readyState: 'complete',
    visibilityState: 'visible',
    title: '',
    URL: 'about:blank',
    documentURI: 'about:blank',
    characterSet: 'UTF-8',
    getElementById: function (id) {
      var wanted = String(id);
      for (var i = 0; i < allElements.length; i++) {
        if (allElements[i].id === wanted) return allElements[i];
      }
      return null;
    },
    querySelector: function (selector) { return queryAll(root, selector)[0] || null; },
    querySelectorAll: function (selector) { return queryAll(root, selector); },
    getElementsByTagName: function (tag) { return queryAll(root, String(tag)); },
    getElementsByClassName: function (className) {
      return queryAll(root, '.' + String(className).trim().split(/\s+/).join('.'));
    },
    createElement: function (tag) { return new Element(tag, []); },
    createElementNS: function (namespace, tag) { return new Element(tag, []); },
    createTextNode: function (text) { return new TextNode(text); },
    createDocumentFragment: function () { return new Element('#fragment', []); },
    addEventListener: function (type, listener) {
      if (typeof listener !== 'function') return;
      var key = String(type);
      (documentListeners[key] || (documentListeners[key] = [])).push(listener);
    },
    removeEventListener: noop,
    dispatchEvent: function () { return true; },
    hasFocus: function () { return true; },
    execCommand: function () { return false; },
  };

  function firstByTag(tag) {
    for (var i = 0; i < allElements.length; i++) {
      if (allElements[i].localName === tag) return allElements[i];
    }
    return null;
  }
  document.documentElement = firstByTag('html') || new Element('html', []);
  document.head = firstByTag('head') || new Element('head', []);
  document.body = firstByTag('body') || new Element('body', []);
  root.parentNode = document;
  globalThis.document = document;

  function Event(type, options) {
    var opts = options || {};
    this.type = String(type);
    this.bubbles = !!opts.bubbles;
    this.cancelable = !!opts.cancelable;
    this.composed = !!opts.composed;
    this.defaultPrevented = false;
    this.target = null;
    this.currentTarget = null;
    this.detail = opts.detail === undefined ? 0 : opts.detail;
    this.isTrusted = false;
  }
  Event.prototype.preventDefault = function () { this.defaultPrevented = true; };
  Event.prototype.stopPropagation = noop;
  Event.prototype.stopImmediatePropagation = noop;
  Event.prototype.composePath = function () { return []; };
  function CustomEvent(type, options) {
    Event.call(this, type, options);
    this.detail = options && options.detail !== undefined ? options.detail : null;
  }
  CustomEvent.prototype = Object.create(Event.prototype);
  CustomEvent.prototype.constructor = CustomEvent;
  globalThis.Event = Event;
  globalThis.CustomEvent = CustomEvent;
  globalThis.MouseEvent = Event;
  globalThis.KeyboardEvent = Event;
  globalThis.PointerEvent = Event;
  globalThis.UIEvent = Event;
  globalThis.FocusEvent = Event;

  globalThis.window = globalThis;
  globalThis.self = globalThis;
  globalThis.frames = globalThis;
  globalThis.top = globalThis;
  globalThis.parent = globalThis;
  var windowListeners = Object.create(null);
  globalThis.addEventListener = function (type, listener) {
    if (typeof listener !== 'function') return;
    var key = String(type);
    (windowListeners[key] || (windowListeners[key] = [])).push(listener);
  };
  globalThis.removeEventListener = noop;
  globalThis.dispatchEvent = function () { return true; };

  // Generated widgets commonly initialise inside load / DOMContentLoaded
  // handlers. A browser fires those after parsing; the sandbox must do the
  // same or a valid widget looks inert and publishes no observation.
  globalThis.__maicFireReady = function () {
    var ready = new Event('DOMContentLoaded', { bubbles: false });
    var docHandlers = documentListeners['DOMContentLoaded'] || [];
    for (var i = 0; i < docHandlers.length; i++) docHandlers[i].call(document, ready);
    var loaded = new Event('load', { bubbles: false });
    var winHandlers = windowListeners['load'] || [];
    for (var j = 0; j < winHandlers.length; j++) winHandlers[j].call(globalThis, loaded);
  };
  // Widget templates load KaTeX and similar helpers from a CDN. External
  // scripts are intentionally not executed, so stub their entry points to
  // avoid a false "not defined" failure on DOMContentLoaded.
  globalThis.renderMathInElement = noop;
  globalThis.katex = { renderToString: function () { return ''; }, render: noop };
  globalThis.innerWidth = 1024;
  globalThis.innerHeight = 768;
  globalThis.outerWidth = 1024;
  globalThis.outerHeight = 768;
  globalThis.devicePixelRatio = 1;
  globalThis.scrollX = 0;
  globalThis.scrollY = 0;
  globalThis.scrollTo = noop;
  globalThis.navigator = {
    userAgent: 'OpenMAIC widget sandbox',
    appName: 'OpenMAIC',
    language: 'en-US',
    languages: ['en-US'],
    platform: 'sandbox',
    hardwareConcurrency: 1,
    maxTouchPoints: 0,
    clipboard: { writeText: function () { return Promise.resolve(); } },
  };
  globalThis.location = {
    href: 'about:blank',
    protocol: 'about:',
    host: '',
    hostname: '',
    port: '',
    pathname: 'blank',
    search: '',
    hash: '',
    origin: 'null',
    reload: noop,
    assign: noop,
    replace: noop,
    toString: function () { return 'about:blank'; },
  };
  globalThis.history = { length: 1, state: null, pushState: noop, replaceState: noop, back: noop, forward: noop, go: noop };
  globalThis.screen = { width: 1024, height: 768, availWidth: 1024, availHeight: 768, colorDepth: 24 };
  var storage = {
    length: 0,
    getItem: function () { return null; },
    setItem: noop,
    removeItem: noop,
    clear: noop,
    key: function () { return null; },
  };
  globalThis.localStorage = storage;
  globalThis.sessionStorage = storage;
  globalThis.getComputedStyle = function () {
    return { getPropertyValue: function () { return ''; }, removeProperty: noop, setProperty: noop };
  };
  globalThis.matchMedia = function () {
    return { matches: false, media: '', addEventListener: noop, removeEventListener: noop, addListener: noop, removeListener: noop };
  };
  globalThis.alert = noop;
  globalThis.confirm = function () { return false; };
  globalThis.prompt = function () { return null; };

  globalThis.console = {
    log: noop, info: noop, warn: noop, error: noop, debug: noop, trace: noop,
    table: noop, group: noop, groupCollapsed: noop, groupEnd: noop,
    time: noop, timeEnd: noop, timeLog: noop, assert: noop, clear: noop, dir: noop,
  };

  globalThis.performance = {
    timeOrigin: 0,
    now: function () { return 0; },
    mark: noop,
    measure: noop,
    clearMarks: noop,
    clearMeasures: noop,
    getEntriesByName: function () { return []; },
    getEntriesByType: function () { return []; },
    getEntries: function () { return []; },
  };

  var timerId = 0;
  globalThis.setTimeout = function () { timerId += 1; return timerId; };
  globalThis.setInterval = function () { timerId += 1; return timerId; };
  globalThis.clearTimeout = noop;
  globalThis.clearInterval = noop;
  globalThis.setImmediate = function () { timerId += 1; return timerId; };
  globalThis.clearImmediate = noop;
  globalThis.requestAnimationFrame = function () { timerId += 1; return timerId; };
  globalThis.cancelAnimationFrame = noop;
  globalThis.requestIdleCallback = function () { timerId += 1; return timerId; };
  globalThis.cancelIdleCallback = noop;
  globalThis.queueMicrotask = noop;

  function Observer() {}
  Observer.prototype.observe = noop;
  Observer.prototype.unobserve = noop;
  Observer.prototype.disconnect = noop;
  Observer.prototype.takeRecords = function () { return []; };
  globalThis.MutationObserver = Observer;
  globalThis.ResizeObserver = Observer;
  globalThis.IntersectionObserver = Observer;
  globalThis.PerformanceObserver = Observer;

  globalThis.TextEncoder = function () {};
  globalThis.TextEncoder.prototype.encode = function (input) {
    var text = String(input === undefined || input === null ? '' : input);
    var count = 0;
    for (var i = 0; i < text.length; i++) {
      var code = text.charCodeAt(i);
      if (code < 0x80) {
        count += 1;
      } else if (code < 0x800) {
        count += 2;
      } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length &&
        text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) {
        count += 4;
        i += 1;
      } else {
        count += 3;
      }
    }
    return new Uint8Array(count);
  };
  globalThis.TextDecoder = function () {};
  globalThis.TextDecoder.prototype.decode = function () { return ''; };

  globalThis.__maicDrive = function (id, value) {
    var el = document.getElementById(id);
    if (!el) return false;
    el.value = String(value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  };
  globalThis.__maicGetObservation = function () {
    var nodes = queryAll(root, 'script[data-maic-observation]');
    if (!nodes.length) return null;
    var text = nodes[0].textContent;
    return text === undefined || text === null ? null : String(text);
  };
  globalThis.__maicGetVisibleText = function () {
    var out = {};
    for (var i = 0; i < allElements.length; i++) {
      var el = allElements[i];
      var id = el.id;
      if (!id) continue;
      if (/-display$|-hud$/i.test(id) || /status|badge/i.test(id)) {
        out[id] = String(el.textContent);
      }
    }
    return JSON.stringify(out);
  };
})();
`;

function isElement(
  node: DefaultTreeAdapterTypes.ChildNode,
): node is DefaultTreeAdapterTypes.Element {
  return node.nodeName[0] !== '#';
}

function isTextNode(
  node: DefaultTreeAdapterTypes.ChildNode,
): node is DefaultTreeAdapterTypes.TextNode {
  return node.nodeName === '#text';
}

function isTemplate(
  node: DefaultTreeAdapterTypes.Element,
): node is DefaultTreeAdapterTypes.Template {
  return node.tagName === 'template' && 'content' in node;
}

function classicScriptType(attributes: ReadonlyMap<string, string>): string {
  return (attributes.get('type') ?? '').trim().toLowerCase().split(';', 1)[0]!.trim();
}

function isExecutableClassicInline(element: DefaultTreeAdapterTypes.Element): boolean {
  const attributes = new Map<string, string>();
  for (const attribute of element.attrs) {
    const name = attribute.name.toLowerCase();
    if (!attributes.has(name)) attributes.set(name, attribute.value);
  }
  if (attributes.has('src')) return false;
  return CLASSIC_JAVASCRIPT_TYPES.has(classicScriptType(attributes));
}

/** Inline classic script bodies in document order; data scripts and templates are skipped. */
function collectClassicScripts(html: string): string[] {
  const sources: string[] = [];
  const visit = (parent: DefaultTreeAdapterTypes.ParentNode, inTemplate: boolean): void => {
    for (const child of parent.childNodes) {
      if (!isElement(child)) continue;
      if (child.tagName === 'script') {
        if (!inTemplate && isExecutableClassicInline(child)) {
          const source = child.childNodes
            .filter(isTextNode)
            .map((node) => node.value)
            .join('');
          if (source.trim()) sources.push(source);
        }
        continue;
      }
      if (isTemplate(child)) {
        visit(child.content, true);
        continue;
      }
      if ('childNodes' in child) visit(child, inTemplate);
    }
  };
  visit(parse(html), false);
  return sources;
}

interface DomDescriptor {
  tag: string;
  text?: string;
  attrs: Array<[string, string]>;
  children: DomDescriptor[];
}

/** Minimal element descriptors (id, tag, attributes, text) for the vm-side DOM. */
function collectDomDescriptors(html: string): DomDescriptor {
  const toDescriptor = (node: DefaultTreeAdapterTypes.ChildNode): DomDescriptor | null => {
    if (isTextNode(node)) {
      return { tag: '#text', text: node.value, attrs: [], children: [] };
    }
    if (!isElement(node)) return null;
    return {
      tag: node.tagName.toLowerCase(),
      attrs: node.attrs.map((attribute) => [attribute.name.toLowerCase(), attribute.value]),
      children: node.childNodes
        .map(toDescriptor)
        .filter((value): value is DomDescriptor => value !== null),
    };
  };
  return {
    tag: '#document',
    attrs: [],
    children: parse(html)
      .childNodes.map(toDescriptor)
      .filter((value): value is DomDescriptor => value !== null),
  };
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function runExpression<T>(context: Context, expression: string): T {
  return new Script(expression, { filename: 'widget-sandbox-probe.js' }).runInContext(context, {
    timeout: PROBE_TIMEOUT_MS,
  }) as T;
}

interface ProbeSpec {
  label: string;
  values: Record<string, number>;
}

/**
 * Execute a generated simulation widget's inline scripts in a frozen, minimal
 * DOM and record the observation published at several slider states.
 *
 * Inline scripts are concatenated into ONE `Script` because top-level
 * `const`/`let` from separate `runInContext` calls do not reliably share a
 * lexical scope across scripts; browsers instead give all classic inline
 * scripts one global lexical scope. Concatenating reproduces that closely
 * enough for generated widgets and lets one script's helpers be used by the
 * next. Nothing runs outside the vm context: host code only passes a JSON
 * string of element descriptors in and reads primitive strings back.
 */
export function probeWidgetHtml(html: string, options: WidgetProbeOptions): WidgetProbeResult {
  const errors: string[] = [];
  const snapshots: WidgetProbeSnapshot[] = [];

  let context: Context;
  try {
    context = createContext({});
    (context as Record<string, unknown>).__MAIC_DOM_JSON__ = JSON.stringify(
      collectDomDescriptors(html),
    );
    const sources = collectClassicScripts(html);
    const source = [SANDBOX_BOOTSTRAP, '/* --- generated widget scripts --- */', ...sources].join(
      '\n',
    );
    new Script(source, { filename: 'widget-sandbox.js' }).runInContext(context, {
      timeout: INIT_TIMEOUT_MS,
      displayErrors: true,
    });
    // Let event-driven widgets initialise before the first probe, just as a
    // browser would after parsing the document.
    runExpression(context, '__maicFireReady()');
  } catch (error) {
    errors.push(describeError(error));
    return { snapshots, errors };
  }

  const variables = options.variables;
  const defaults: Record<string, number> = {};
  for (const variable of variables) {
    defaults[variable.name] =
      typeof variable.default === 'number' ? variable.default : variable.min;
  }

  const specs: ProbeSpec[] = [{ label: 'default', values: { ...defaults } }];
  for (const preset of options.presets) {
    specs.push({ label: `preset:${preset.name}`, values: { ...defaults, ...preset.variables } });
  }
  for (const variable of variables) {
    specs.push({
      label: `var:${variable.name}=min`,
      values: { ...defaults, [variable.name]: variable.min },
    });
    specs.push({
      label: `var:${variable.name}=max`,
      values: { ...defaults, [variable.name]: variable.max },
    });
  }

  for (const spec of specs.slice(0, MAX_SNAPSHOTS)) {
    for (const variable of variables) {
      const id = `${variable.name}-slider`;
      const value = spec.values[variable.name];
      let present = false;
      try {
        present = runExpression<boolean>(
          context,
          `__maicDrive(${JSON.stringify(id)}, ${JSON.stringify(value)})`,
        );
      } catch (error) {
        errors.push(`Probe ${spec.label}: ${describeError(error)}`);
      }
      if (
        !present &&
        errors.every((message) => !message.includes(`Missing slider element: ${id}`))
      ) {
        errors.push(`Missing slider element: ${id} (probe ${spec.label})`);
      }
    }

    let published: Record<string, unknown> | null = null;
    try {
      const raw = runExpression<string | null>(context, '__maicGetObservation()');
      if (raw !== null) {
        if (Buffer.byteLength(raw, 'utf8') > MAX_OBSERVATION_BYTES) {
          errors.push(`Probe ${spec.label}: observation JSON exceeds 64 KB`);
        } else {
          const parsed: unknown = JSON.parse(raw);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            published = parsed as Record<string, unknown>;
          } else {
            errors.push(`Probe ${spec.label}: observation JSON is not an object`);
          }
        }
      }
    } catch (error) {
      errors.push(`Probe ${spec.label}: ${describeError(error)}`);
    }

    let visibleText: Record<string, string> = {};
    try {
      const raw = runExpression<string>(context, '__maicGetVisibleText()');
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        visibleText = parsed as Record<string, string>;
      }
    } catch (error) {
      errors.push(`Probe ${spec.label}: ${describeError(error)}`);
    }

    snapshots.push({ label: spec.label, values: spec.values, published, visibleText });
  }

  return { snapshots, errors };
}
