import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";

/**
 *
 * @param {String} mentionTrigger
 * @param {String} hashtagTrigger
 * @param {bool} allowSpace
 * @returns {Object}
 */
function getRegexp(mentionTrigger, hashtagTrigger, allowSpace) {
  var mention = allowSpace
    ? new RegExp("(^|\\s)" + mentionTrigger + "([\\w-\\+]+\\s?[\\w-\\+]*)$")
    : new RegExp("(^|\\s)" + mentionTrigger + "([\\w-\\+]+)$");

  // hashtags should never allow spaces. I mean, what's the point of allowing spaces in hashtags? <- Some tagged slide with a name -..-
  var tag = allowSpace
    ? new RegExp("(^|\\s)" + hashtagTrigger + "([\\w-\\+]*\\s?[\\w-\\+]*)$")
    : new RegExp("(^|\\s)" + hashtagTrigger + "([\\w-]*)$");

  return {
    mention: mention,
    tag: tag
  };
}

/**
 *
 * @param {ResolvedPosition} $position https://prosemirror.net/docs/ref/#model.Resolved_Positions
 * @param {JSONObject} opts
 * @returns {JSONObject}
 */
function getMatch($position, opts) {
  // take current para text content upto cursor start.
  // this makes the regex simpler and parsing the matches easier.
  var parastart = $position.before();
  var text = $position.doc.textBetween(parastart, $position.pos, "\n", "\0");

  var regex = getRegexp(
    opts.mentionTrigger,
    opts.hashtagTrigger,
    opts.allowSpace
  );

  // only one of the below matches will be true.
  var mentionMatch = text.match(regex.mention);
  var tagMatch = text.match(regex.tag);

  var match = mentionMatch || tagMatch;

  // set type of match
  var type;
  if (mentionMatch) {
    type = "mention";
  } else if (tagMatch) {
    type = "tag";
  }

  // if match found, return match with useful information.
  if (match) {
    // adjust match.index to remove the matched extra space
    match.index = match[0].startsWith(" ") ? match.index + 1 : match.index;
    match[0] = match[0].startsWith(" ")
      ? match[0].substring(1, match[0].length)
      : match[0];

    // The absolute position of the match in the document
    var from = $position.start() + match.index;
    var to = from + match[0].length;

    var queryText = match[2];

    return {
      range: { from: from, to: to },
      queryText: queryText,
      type: type
    };
  }
  // else if no match don't return anything.
}

/**
 * Util to debounce call to a function.
 * >>> debounce(function(){}, 1000, this)
 */
var debounce = (function() {
  var timeoutId = null;
  return function(func, timeout, context) {
    context = context || this;
    clearTimeout(timeoutId);
    timeoutId = setTimeout(function() {
      func.apply(context, arguments);
    }, timeout);

    return timeoutId;
  };
})();

var getNewState = function getNewState() {
  return {
    active: false,
    range: {
      from: 0,
      to: 0
    },
    type: "", //mention or tag
    text: "",
    suggestions: [],
    index: 0 // current active suggestion index
  };
};

/**
 * @param {JSONObject} opts
 * @returns {Plugin}
 */
function getMentionsPlugin(opts) {
  // default options
  var defaultOpts = {
    mentionTrigger: "@",
    hashtagTrigger: "#",
    allowSpace: true,
    getSuggestions: function getSuggestions(type, text, cb) {
      cb([]);
    },
    getSuggestionsHTML: function getSuggestionsHTML(items) {
      return (
        '<div class="suggestion-item-list">' +
        items
          .map(function(i) {
            return '<div class="suggestion-item">' + i.name + "</div>";
          })
          .join("") +
        "</div>"
      );
    },
    activeClass: "suggestion-item-active",
    suggestionTextClass: "prosemirror-suggestion",
    maxNoOfSuggestions: 10,
    delay: 500
  };

  var opts = Object.assign({}, defaultOpts, opts);

  // timeoutId for clearing debounced calls
  var showListTimeoutId = null;

  // dropdown element
  var el = document.createElement("div");

  // current Idx
  var showList = function showList(view, state, suggestions, opts) {
    el.innerHTML = opts.getSuggestionsHTML(suggestions, state.type);

    // attach new item event handlers
    el.querySelectorAll(".suggestion-item").forEach(function(itemNode, index) {
      itemNode.addEventListener("click", function() {
        select(view, state, opts);
        view.focus();
      });
      // TODO: setIndex() needlessly queries.
      // We already have the itemNode. SHOULD OPTIMIZE.
      itemNode.addEventListener("mouseover", function() {
        setIndex(index, state, opts);
      });
      itemNode.addEventListener("mouseout", function() {
        setIndex(index, state, opts);
      });
    });

    // highlight first element by default - like Facebook.
    addClassAtIndex(state.index, opts.activeClass);

    // get current @mention span left and top.
    // TODO: knock off domAtPos usage. It's not documented and is not officially a public API.
    // It's used currently, only to optimize the the query for textDOM
    var node = view.domAtPos(view.state.selection.$from.pos);
    var paraDOM = node.node;
    var textDOM = paraDOM.querySelector("." + opts.suggestionTextClass);

    // TODO: should add null check case for textDOM
    var offset = textDOM.getBoundingClientRect();

    // TODO: think about outsourcing this positioning logic as options
    document.body.appendChild(el);
    el.style.position = "absolute";
    el.style.zIndex = 100000;
    el.style.left = offset.left + window.pageXOffset + "px";

    var top = textDOM.offsetHeight + offset.top + window.pageYOffset;
    el.style.top = top + "px";
    el.style.display = "block";
  };

  var hideList = function hideList() {
    el.style.display = "none";
  };

  var removeClassAtIndex = function removeClassAtIndex(index, className) {
    var itemList = el.querySelector(".suggestion-item-list").childNodes;
    var prevItem = itemList[index];
    prevItem && prevItem.classList.remove(className);
  };

  var addClassAtIndex = function addClassAtIndex(index, className) {
    var itemList = el.querySelector(".suggestion-item-list").childNodes;
    var prevItem = itemList[index];
    prevItem && prevItem.classList.add(className);
  };

  var setIndex = function setIndex(index, state, opts) {
    removeClassAtIndex(state.index, opts.activeClass);
    state.index = index;
    addClassAtIndex(state.index, opts.activeClass);
  };

  var goNext = function goNext(view, state, opts) {
    removeClassAtIndex(state.index, opts.activeClass);
    state.index++;
    state.index = state.index === state.suggestions.length ? 0 : state.index;
    addClassAtIndex(state.index, opts.activeClass);
  };

  var goPrev = function goPrev(view, state, opts) {
    removeClassAtIndex(state.index, opts.activeClass);
    state.index--;
    state.index =
      state.index === -1 ? state.suggestions.length - 1 : state.index;
    addClassAtIndex(state.index, opts.activeClass);
  };

  var select = function select(view, state, opts) {
    var item = state.suggestions[state.index];
    var node = view.state.schema.nodes[state.type].create(item);
    var tr = view.state.tr.replaceWith(state.range.from, state.range.to, node);

    var newState = view.state.apply(tr);
    view.updateState(newState);
  };

  /**
   * See https://prosemirror.net/docs/ref/#state.Plugin_System
   * for the plugin properties spec.
   */
  return new Plugin({
    key: new PluginKey("autosuggestions"),

    // we will need state to track if suggestion dropdown is currently active or not
    state: {
      init: function init() {
        return getNewState();
      },
      apply: function apply(tr, state) {
        // compute state.active for current transaction and return
        var newState = getNewState();
        var selection = tr.selection;
        if (selection.from !== selection.to) {
          return newState;
        }

        var $position = selection.$from;
        var match = getMatch($position, opts);

        // if match found update state
        if (match) {
          newState.active = true;
          newState.range = match.range;
          newState.type = match.type;
          newState.text = match.queryText;
        }

        return newState;
      }
    },

    // We'll need props to hi-jack keydown/keyup & enter events when suggestion dropdown
    // is active.
    props: {
      handleKeyDown: function handleKeyDown(view, e) {
        var state = this.getState(view.state);

        // don't handle if no suggestions or not in active mode
        if (!state.active && !state.suggestions.length) {
          return false;
        }

        // if any of the below keys, override with custom handlers.
        var down, up, enter, esc;
        enter = e.keyCode === 13;
        down = e.keyCode === 40;
        up = e.keyCode === 38;
        esc = e.keyCode === 27;

        if (down) {
          goNext(view, state, opts);
          return true;
        } else if (up) {
          goPrev(view, state, opts);
          return true;
        } else if (enter) {
          select(view, state, opts);
          return true;
        } else if (esc) {
          clearTimeout(showListTimeoutId);
          hideList();
          this.state = getNewState();
          return true;
        } else {
          // didn't handle. handover to prosemirror for handling.
          return false;
        }
      },

      // to decorate the currently active @mention text in ui
      decorations: function decorations(editorState) {
        var _getState = this.getState(editorState),
          active = _getState.active,
          range = _getState.range;

        if (!active) return null;

        return DecorationSet.create(editorState.doc, [
          Decoration.inline(range.from, range.to, {
            nodeName: "span",
            class: opts.suggestionTextClass
          })
        ]);
      }
    },

    // To track down state mutations and add dropdown reactions
    view: function view() {
      var _this = this;

      return {
        update: function update(view) {
          var state = _this.key.getState(view.state);
          if (!state.active) {
            hideList();
            clearTimeout(showListTimeoutId);
            return;
          }
          // debounce the call to avoid multiple requests
          showListTimeoutId = debounce(
            function() {
              // get suggestions and set new state
              opts.getSuggestions(state.type, state.text, function(
                suggestions
              ) {
                // update `state` argument with suggestions
                state.suggestions = suggestions;
                showList(view, state, suggestions, opts);
              });
            },
            opts.delay,
            _this
          );
        }
      };
    }
  });
}

/**
 * See https://prosemirror.net/docs/ref/#model.NodeSpec
 */
var mentionNode = {
  group: "inline",
  inline: true,
  atom: true,

  attrs: {
    id: "",
    name: "",
    email: ""
  },

  selectable: false,
  draggable: false,

  toDOM: function toDOM(node) {
    return [
      "span",
      {
        "data-mention-id": node.attrs.id,
        "data-mention-name": node.attrs.name,
        "data-mention-email": node.attrs.email,
        class: "prosemirror-mention-node"
      },
      "@" + node.attrs.name || node.attrs.email
    ];
  },

  parseDOM: [
    {
      // match tag with following CSS Selector
      tag: "span[data-mention-id][data-mention-name][data-mention-email]",

      getAttrs: function getAttrs(dom) {
        var id = dom.getAttribute("data-mention-id");
        var name = dom.getAttribute("data-mention-name");
        var email = dom.getAttribute("data-mention-email");
        return {
          id: id,
          name: name,
          email: email
        };
      }
    }
  ]
};

/**
 * See https://prosemirror.net/docs/ref/#model.NodeSpec
 */
var tagNode = {
  group: "inline",
  inline: true,
  atom: true,

  attrs: {
    tag: ""
  },

  selectable: false,
  draggable: false,

  toDOM: function toDOM(node) {
    return [
      "span",
      {
        "data-tag": node.attrs.tag,
        class: "prosemirror-tag-node"
      },
      "#" + node.attrs.tag
    ];
  },

  parseDOM: [
    {
      // match tag with following CSS Selector
      tag: "span[data-tag]",

      getAttrs: function getAttrs(dom) {
        var tag = dom.getAttribute("data-tag");
        return {
          tag: tag
        };
      }
    }
  ]
};

/**
 *
 * @param {OrderedMap} nodes
 * @returns {OrderedMap}
 */
function addMentionNodes(nodes) {
  return nodes.append({
    mention: mentionNode
  });
}

/**
 *
 * @param {OrderedMap} nodes
 * @returns {OrderedMap}
 */
function addTagNodes(nodes) {
  return nodes.append({
    tag: tagNode
  });
}

export {
  getMentionsPlugin,
  addMentionNodes,
  addTagNodes,
  tagNode,
  mentionNode
};
//# sourceMappingURL=index.es.js.map
