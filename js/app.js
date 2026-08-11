/* ============================================================
   MODIFIER CONSOLE â€” app.js
   Reads data/versions.json to discover available data versions,
   then for the active version reads
     data/<version>/1-stars.json .. 4-stars.json + stars-map.json
     data/<version>/conflict.json (optional â€” mutually-exclusive mods)
   Assigns global sequential IDs to every modifier in array order
   (order is preserved exactly as written â€” boosts are NOT assumed
   to be sorted). Renders a selectable list, tracks totals, and
   builds/reads shareable permalinks of the form
     ?b=<bitset-packed, base64url selected modifier ids>&cf=<version slug>
   ("b" packs one bit per possible id into bytes then base64url-encodes
   them â€” length depends only on the highest id in the version, not on
   how many are selected, which keeps the URL short.)
   IDs are only meaningful within the version they came from, which
   is why the version slug travels alongside the selection in every
   permalink and in local storage.

   Data is always fetched fresh (cache: "no-store", no localStorage
   caching of the JSON payload) so editing the JSON files and
   reloading the page always shows the latest content â€” no need to
   clear the browser cache.
   ============================================================ */

(function () {
  "use strict";

  var TIER_FILES = ["1", "2", "3", "4"];
  var DATA_DIR = "data/";
  var VERSIONS_MANIFEST = DATA_DIR + "versions.json";
  var SELECTION_KEY_PREFIX = "mc_selection::"; // + version slug
  var LAST_VERSION_KEY = "mc_last_version";

  /** @type {Array<{id:number,name:string,desc:string,boost:number,tier:string}>} */
  var registry = [];
  /** tier -> normalized entry list for the active version */
  var tiersData = { "1": [], "2": [], "3": [], "4": [] };
  /** id -> registry entry, for O(1) lookups */
  var byId = {};
  /** raw conflict groups for the active version: Array<Array<modifierName>> */
  var conflictGroups = [];
  /** id -> Set of ids it mutually conflicts with, for the active version */
  var conflictMap = {};

  var versionsManifest = { default: "", versions: [] };
  var currentVersion = "";

  var selected = new Set();
  var starMap = { zero: 0, one: 50, two: 150, three: 250, four: 350 };
  var currentTab = "all";

  var els = {};

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    cacheEls();
    bindGlobalUI();

    fetchJSON(VERSIONS_MANIFEST)
      .then(function (manifest) {
        versionsManifest = normalizeManifest(manifest);
        populateVersionSelect();
        var initialVersion = resolveInitialVersion();
        return switchToVersion(initialVersion, { fromURL: true });
      })
      .catch(function (err) {
        showError(err);
      });
  }

  function cacheEls() {
    els.list = document.getElementById("modifier-list");
    els.listTitle = document.getElementById("list-title");
    els.listCount = document.getElementById("list-count");
    els.summaryList = document.getElementById("summary-list");
    els.selectedCount = document.getElementById("selected-count");
    els.totalBoost = document.getElementById("total-boost");
    els.starGaugeFill = document.getElementById("star-gauge-fill");
    els.starGaugeTicks = document.getElementById("star-gauge-ticks");
    els.starIcons = document.getElementById("star-icons");
    els.starBandLabel = document.getElementById("star-band-label");
    els.starNextLabel = document.getElementById("star-next-label");
    els.tabs = Array.prototype.slice.call(document.querySelectorAll(".tab"));
    els.versionSelect = document.getElementById("version-select");
    els.permalinkBtn = document.getElementById("permalink-btn");
    els.resetBtn = document.getElementById("reset-btn");
    els.popover = document.getElementById("desc-popover");
    els.popoverTitle = document.getElementById("desc-popover-title");
    els.popoverBody = document.getElementById("desc-popover-body");
    els.toast = document.getElementById("toast");
  }

  function bindGlobalUI() {
    els.tabs.forEach(function (tab) {
      tab.addEventListener("click", function () {
        currentTab = tab.getAttribute("data-tab");
        els.tabs.forEach(function (t) {
          t.classList.toggle("active", t === tab);
          t.setAttribute("aria-selected", t === tab ? "true" : "false");
        });
        renderList();
      });
    });

    els.versionSelect.addEventListener("change", function () {
      var slug = els.versionSelect.value;
      if (slug === currentVersion) return;
      switchToVersion(slug, { fromURL: false, clearSelection: true });
    });

    els.permalinkBtn.addEventListener("click", copyPermalink);
    els.resetBtn.addEventListener("click", resetAll);

    document.addEventListener("click", function (e) {
      if (
        !els.popover.hidden &&
        !els.popover.contains(e.target) &&
        !e.target.classList.contains("mod-name-btn")
      ) {
        els.popover.hidden = true;
      }
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") els.popover.hidden = true;
    });
  }

  /* ---------------- version manifest + selector ---------------- */

  function normalizeManifest(manifest) {
    var versions = Array.isArray(manifest && manifest.versions) ? manifest.versions : [];
    versions = versions.filter(function (v) {
      return v && typeof v.slug === "string" && v.slug.length;
    });
    var def = manifest && manifest.default;
    if (!versions.some(function (v) { return v.slug === def; })) {
      def = versions.length ? versions[0].slug : "";
    }
    return { default: def, versions: versions };
  }

  function populateVersionSelect() {
    els.versionSelect.innerHTML = "";
    versionsManifest.versions.forEach(function (v) {
      var opt = document.createElement("option");
      opt.value = v.slug;
      opt.textContent = v.label || v.slug;
      els.versionSelect.appendChild(opt);
    });
  }

  function resolveInitialVersion() {
    var params = new URLSearchParams(window.location.search);
    var cf = params.get("cf");
    if (cf && versionExists(cf)) return cf;

    var last = readLastVersion();
    if (last && versionExists(last)) return last;

    return versionsManifest.default;
  }

  function versionExists(slug) {
    return versionsManifest.versions.some(function (v) { return v.slug === slug; });
  }

  function readLastVersion() {
    try {
      return localStorage.getItem(LAST_VERSION_KEY);
    } catch (e) {
      return null;
    }
  }

  function writeLastVersion(slug) {
    try {
      localStorage.setItem(LAST_VERSION_KEY, slug);
    } catch (e) {
      /* ignore */
    }
  }

  /**
   * Load a version's data, rebuild the registry, and (re)hydrate
   * selection state, then render.
   * options.fromURL        â€” true on initial page load: honor ?b= for this version
   * options.clearSelection â€” true when the user manually switches
   *                          versions via the dropdown: start from
   *                          that version's own cached selection (if any)
   */
  function switchToVersion(slug, options) {
    options = options || {};
    currentVersion = slug;
    els.versionSelect.value = slug;
    writeLastVersion(slug);

    return loadVersionData(slug)
      .then(function () {
        buildRegistry();
        conflictMap = buildConflictMap(registry, conflictGroups);

        if (options.clearSelection) {
          selected = new Set(readSelectionCache(slug));
        } else if (options.fromURL) {
          hydrateSelectionFromURLOrCache(slug);
        }

        persistSelection();
        renderList();
        renderSummary();
      });
  }

  /* ---------------- data loading (always fresh, no caching) ---------------- */

  function loadVersionData(slug) {
    var dir = DATA_DIR + encodeURIComponent(slug) + "/";
    var fetches = TIER_FILES.map(function (n) {
      return fetchJSON(dir + n + "-stars.json");
    });
    fetches.push(fetchJSON(dir + "stars-map.json"));

    return Promise.all(fetches)
      .then(function (results) {
        tiersData["1"] = results[0] || [];
        tiersData["2"] = results[1] || [];
        tiersData["3"] = results[2] || [];
        tiersData["4"] = results[3] || [];
        starMap = results[4] || starMap;

        // conflict.json is optional â€” a version with no conflicts simply
        // doesn't ship the file, or ships { "conflicted": [] }.
        return fetchJSONOptional(dir + "conflict.json");
      })
      .then(function (raw) {
        conflictGroups = normalizeConflictGroups(raw);
      });
  }

  function fetchJSON(path) {
    // cache: "no-store" bypasses the HTTP cache too, so edited JSON
    // files always show up on the next reload without the user
    // needing to clear site data.
    return fetch(path, { cache: "no-store" }).then(function (res) {
      if (!res.ok) throw new Error("Failed to load " + path + " (" + res.status + ")");
      return res.json();
    });
  }

  // Like fetchJSON, but a missing/invalid file resolves to null instead
  // of rejecting the whole version load â€” used for the optional
  // conflict.json.
  function fetchJSONOptional(path) {
    return fetch(path, { cache: "no-store" })
      .then(function (res) {
        if (!res.ok) return null;
        return res.json();
      })
      .catch(function () {
        return null;
      });
  }

  /* ---------------- registry (global sequential ids, per version) ---------------- */

  // Each tier file is a flat array, in display order, of single-key
  // objects: [{ "Mod Name": { "desc": "...", "boost": 5 } }, ...]
  // Order in the array is preserved as-is (boosts are NOT sorted â€”
  // a file can legitimately go 5, 10, 5, 15, 10, 40, ...).
  // The inner object's keys aren't assumed to be named exactly "desc"/
  // "boost": any string value found is treated as the description and
  // any number value as the boost.
  function parseModifierEntry(rawObj) {
    var keys = Object.keys(rawObj || {});
    if (!keys.length) return null;
    var name = keys[0];
    var inner = rawObj[name];
    var desc = "";
    var boost = 0;
    if (inner && typeof inner === "object") {
      Object.keys(inner).forEach(function (k) {
        var v = inner[k];
        if (typeof v === "number") boost = v;
        else if (typeof v === "string") desc = v;
      });
    }
    return { name: name, desc: desc, boost: boost };
  }

  function buildRegistry() {
    registry = [];
    byId = {};
    var nextId = 1;

    TIER_FILES.forEach(function (tier) {
      var raw = Array.isArray(tiersData[tier]) ? tiersData[tier] : [];
      var entries = [];
      raw.forEach(function (rawObj) {
        var parsed = parseModifierEntry(rawObj);
        if (!parsed) return;
        var entry = {
          id: nextId++,
          name: parsed.name,
          desc: parsed.desc,
          boost: parsed.boost,
          tier: tier
        };
        registry.push(entry);
        byId[entry.id] = entry;
        entries.push(entry);
      });
      tiersData[tier] = entries; // replace raw JSON with normalized list
    });
  }

  /* ---------------- conflicts ---------------- */

  // Expected file shape (valid JSON â€” the format in the original request
  // wasn't valid JSON, so this is the corrected version of it):
  //   { "conflicted": [ ["Mod A", "Mod B"], ["Mod C", "Mod D", "Mod E"] ] }
  // Each inner array is a group of modifiers that are all mutually
  // exclusive with each other (selecting any one blocks every other
  // member of that same group). A modifier can appear in more than one
  // group if it conflicts with different, unrelated sets of modifiers.
  function normalizeConflictGroups(raw) {
    var groups = Array.isArray(raw && raw.conflicted) ? raw.conflicted : [];
    return groups.filter(function (g) {
      return Array.isArray(g) && g.length > 1;
    });
  }

  // Builds id -> Set(conflicting ids). Matching is by exact modifier
  // name against the current version's registry. If the same name is
  // used more than once in a version, all matching entries are treated
  // as the same conflict participant (names should generally be unique
  // within a version for this to behave predictably).
  function buildConflictMap(registry, groups) {
    var idsByName = {};
    registry.forEach(function (entry) {
      if (!idsByName[entry.name]) idsByName[entry.name] = [];
      idsByName[entry.name].push(entry.id);
    });

    var map = {};
    registry.forEach(function (entry) {
      map[entry.id] = new Set();
    });

    groups.forEach(function (group) {
      var idsInGroup = [];
      group.forEach(function (name) {
        (idsByName[name] || []).forEach(function (id) {
          idsInGroup.push(id);
        });
      });
      idsInGroup.forEach(function (id) {
        idsInGroup.forEach(function (otherId) {
          if (id !== otherId) map[id].add(otherId);
        });
      });
    });

    return map;
  }

  // Returns the list of currently-selected ids that block `id` from
  // being selected, or an empty array if it isn't blocked.
  function conflictBlockers(id) {
    if (selected.has(id)) return []; // an already-selected mod is never "blocked"
    var conflicts = conflictMap[id];
    if (!conflicts || !conflicts.size) return [];
    var blockers = [];
    conflicts.forEach(function (otherId) {
      if (selected.has(otherId)) blockers.push(otherId);
    });
    return blockers;
  }

  /* ---------------- selection state (namespaced per version) ---------------- */

  function hydrateSelectionFromURLOrCache(slug) {
    var params = new URLSearchParams(window.location.search);
    var b = params.get("b");
    var cf = params.get("cf");

    // Only trust ?b= for the version it was generated against.
    if (b && cf === slug) {
      var ids = decodeSequence(b);
      if (ids.length) {
        selected = new Set(ids.filter(function (id) { return !!byId[id]; }));
        return;
      }
    }
    selected = new Set(readSelectionCache(slug));
  }

  function readSelectionCache(slug) {
    try {
      var raw = localStorage.getItem(SELECTION_KEY_PREFIX + slug);
      if (!raw) return [];
      var arr = JSON.parse(raw);
      return Array.isArray(arr)
        ? arr.filter(function (id) { return !!byId[id]; })
        : [];
    } catch (e) {
      return [];
    }
  }

  function persistSelection() {
    try {
      localStorage.setItem(
        SELECTION_KEY_PREFIX + currentVersion,
        JSON.stringify(Array.from(selected))
      );
    } catch (e) {
      /* ignore */
    }
    updateURL();
  }

  function updateURL() {
    var url = new URL(window.location.href);
    url.searchParams.set("cf", currentVersion);
    if (selected.size) {
      var ids = Array.from(selected).sort(function (a, b) { return a - b; });
      url.searchParams.set("b", encodeSequence(ids));
    } else {
      url.searchParams.delete("b");
    }
    window.history.replaceState({}, "", url.toString());
  }

  // Bitset encoding: one bit per possible modifier id (bit n set = id n
  // selected), packed into bytes, then base64url'd. Cost is fixed at
  // ceil((maxId+1)/8) bytes regardless of how many ids are selected â€”
  // e.g. ~57 modifiers packs into 8 bytes / ~11 characters whether 1 or
  // 40 of them are selected, which is far shorter than base64-encoding
  // a comma-separated id list (which grows with the selection size).
  // No encodeURIComponent needed: "-" and "_" are already URL-safe.
  function encodeSequence(values) {
    if (!values.length) return "";
    var max = Math.max.apply(null, values.concat([0]));
    var bytes = new Uint8Array(Math.ceil((max + 1) / 8));
    values.forEach(function (n) {
      bytes[n >> 3] |= 1 << (n & 7);
    });
    var binary = "";
    bytes.forEach(function (byte) {
      binary += String.fromCharCode(byte);
    });
    return btoa(binary)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }

  function decodeSequence(encoded) {
    try {
      var binary = atob(encoded.replace(/-/g, "+").replace(/_/g, "/"));
      var values = [];
      for (var byteIndex = 0; byteIndex < binary.length; byteIndex++) {
        var byte = binary.charCodeAt(byteIndex);
        for (var bit = 0; bit < 8; bit++) {
          if (byte & (1 << bit)) values.push(byteIndex * 8 + bit);
        }
      }
      return values;
    } catch (e) {
      return [];
    }
  }

  function toggleSelection(id) {
    if (selected.has(id)) {
      selected.delete(id);
    } else {
      selected.add(id);
    }
    persistSelection();
    renderList();
    renderSummary();
  }

  function resetAll() {
    selected = new Set();
    persistSelection();
    renderList();
    renderSummary();
    els.popover.hidden = true;
    showToast("Selection reset");
  }

  /* ---------------- rendering: list ---------------- */

  var TAB_TITLES = {
    all: "All Modifiers",
    "1": "1 Star Modifiers",
    "2": "2 Star Modifiers",
    "3": "3 Star Modifiers",
    "4": "4 Star Modifiers"
  };

  function renderList() {
    els.listTitle.textContent = TAB_TITLES[currentTab] || "Modifiers";
    els.list.innerHTML = "";

    var tiersToRender = currentTab === "all" ? TIER_FILES : [currentTab];
    var count = 0;

    tiersToRender.forEach(function (tier) {
      var entries = tiersData[tier] || [];
      if (!entries.length) return;

      if (currentTab === "all") {
        var header = document.createElement("div");
        header.className = "tier-header";
        header.textContent = tier + " Star Tier";
        els.list.appendChild(header);
      }

      entries.forEach(function (entry) {
        els.list.appendChild(buildRow(entry));
        count++;
      });
    });

    els.listCount.textContent = count + (count === 1 ? " entry" : " entries");

    if (!count) {
      var empty = document.createElement("p");
      empty.className = "empty-state";
      empty.textContent = "No modifiers found in this tier.";
      els.list.appendChild(empty);
    }
  }

  function buildRow(entry) {
    var blockers = conflictBlockers(entry.id);
    var isDisabled = blockers.length > 0;

    var row = document.createElement("div");
    row.className =
      "mod-row" +
      (selected.has(entry.id) ? " is-selected" : "") +
      (isDisabled ? " is-disabled" : "");
    row.dataset.id = String(entry.id);

    var queueBtn = document.createElement("button");
    queueBtn.type = "button";
    queueBtn.className = "mod-queue";
    queueBtn.setAttribute("aria-pressed", selected.has(entry.id) ? "true" : "false");
    queueBtn.setAttribute("aria-label", "Toggle " + entry.name);
    queueBtn.setAttribute("aria-disabled", isDisabled ? "true" : "false");
    if (isDisabled) {
      var blockerNames = blockers
        .map(function (id) { return byId[id] ? byId[id].name : null; })
        .filter(Boolean);
      queueBtn.title = "Conflicts with: " + blockerNames.join(", ");
    }
    var box = document.createElement("span");
    box.className = "mod-queue-box";
    queueBtn.appendChild(box);
    queueBtn.addEventListener("click", function () {
      var currentBlockers = conflictBlockers(entry.id);
      if (currentBlockers.length) {
        var names = currentBlockers
          .map(function (id) { return byId[id] ? byId[id].name : null; })
          .filter(Boolean);
        showToast("Conflicts with " + names.join(", ") + " â€” deselect it first");
        return;
      }
      toggleSelection(entry.id);
    });

    var nameBtn = document.createElement("button");
    nameBtn.type = "button";
    nameBtn.className = "mod-name-btn";
    nameBtn.textContent = entry.name;
    nameBtn.addEventListener("click", function (e) {
      showPopover(entry, nameBtn);
      e.stopPropagation();
    });

    var boostEl = document.createElement("span");
    boostEl.className = "mod-boost";
    boostEl.textContent = entry.boost + "%";

    row.appendChild(queueBtn);
    row.appendChild(nameBtn);
    row.appendChild(boostEl);
    return row;
  }

  function showPopover(entry, anchorEl) {
    els.popoverTitle.textContent = entry.name;
    els.popoverBody.textContent = entry.desc;
    els.popover.hidden = false;

    var rect = anchorEl.getBoundingClientRect();
    var popW = 320;
    var left = Math.min(rect.left, window.innerWidth - popW - 16);
    left = Math.max(left, 16);
    var top = rect.bottom + 8;
    if (top + 140 > window.innerHeight) {
      top = rect.top - 8;
      els.popover.style.transform = "translateY(-100%)";
    } else {
      els.popover.style.transform = "none";
    }
    els.popover.style.left = left + "px";
    els.popover.style.top = top + "px";
  }

  /* ---------------- rendering: summary + boost + stars ---------------- */

  function renderSummary() {
    var ids = Array.from(selected).sort(function (a, b) { return a - b; });
    els.selectedCount.textContent = ids.length + " selected";

    els.summaryList.innerHTML = "";
    if (!ids.length) {
      var empty = document.createElement("p");
      empty.className = "empty-state";
      empty.textContent = "No modifiers queued. Select entries from the list to begin.";
      els.summaryList.appendChild(empty);
    } else {
      ids.forEach(function (id) {
        var entry = byId[id];
        if (!entry) return;
        var item = document.createElement("div");
        item.className = "summary-item";

        var name = document.createElement("div");
        name.className = "summary-item-name";
        name.textContent = entry.name + " (" + entry.boost + "%)";

        var how = document.createElement("div");
        how.className = "summary-item-how";
        how.textContent = "Description";

        var desc = document.createElement("div");
        desc.className = "summary-item-desc";
        desc.textContent = entry.desc;

        item.appendChild(name);
        item.appendChild(how);
        item.appendChild(desc);
        els.summaryList.appendChild(item);
      });
    }

    var totalBoost = ids.reduce(function (sum, id) {
      var entry = byId[id];
      return sum + (entry ? entry.boost : 0);
    }, 0);

    els.totalBoost.textContent = totalBoost + "%";
    renderStarGauge(totalBoost);
  }

  function renderStarGauge(totalBoost) {
    var bands = [
      { n: 0, val: Number(starMap.zero) || 0 },
      { n: 1, val: Number(starMap.one) || 0 },
      { n: 2, val: Number(starMap.two) || 0 },
      { n: 3, val: Number(starMap.three) || 0 },
      { n: 4, val: Number(starMap.four) || 0 }
    ];

    var current = bands[0];
    bands.forEach(function (b) {
      if (totalBoost >= b.val) current = b;
    });

    var next = bands.filter(function (b) { return b.n === current.n + 1; })[0];

    els.starBandLabel.textContent = current.n + " STAR" + (current.n === 1 ? "" : "S");
    els.starNextLabel.textContent = next
      ? (next.val - totalBoost) + "% to " + next.n + " Stars"
      : "Max tier reached";

    var maxVal = bands[bands.length - 1].val || 1;
    var pct = Math.max(0, Math.min(100, (totalBoost / maxVal) * 100));
    els.starGaugeFill.style.width = pct + "%";

    els.starGaugeTicks.innerHTML = "";
    bands.forEach(function (b) {
      if (b.n === 0) return;
      var tick = document.createElement("div");
      tick.className = "star-gauge-tick";
      tick.style.left = Math.min(100, (b.val / maxVal) * 100) + "%";
      els.starGaugeTicks.appendChild(tick);
    });

    els.starIcons.innerHTML = "";
    for (var i = 1; i <= 4; i++) {
      var icon = document.createElement("span");
      icon.className = "star-icon" + (i <= current.n ? " is-lit" : "");
      icon.textContent = "\u2605";
      els.starIcons.appendChild(icon);
    }
  }

  /* ---------------- permalink + misc UI ---------------- */

  function copyPermalink() {
    updateURL();
    var url = window.location.href;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard
        .writeText(url)
        .then(function () { showToast("Permalink copied"); })
        .catch(function () { showToast(url); });
    } else {
      showToast(url);
    }
  }

  var toastTimer = null;
  function showToast(msg) {
    els.toast.textContent = msg;
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      els.toast.hidden = true;
    }, 2400);
  }

  function showError(err) {
    console.error(err);
    els.list.innerHTML =
      '<p class="empty-state">Failed to load modifier data. Check that data/versions.json and data/&lt;version&gt;/*.json exist and are valid JSON.</p>';
  }
})();
