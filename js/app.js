/* ============================================================
   MODIFIER CONSOLE — app.js
   Reads data/versions.json to discover available data versions,
   then for the active version reads
     data/<version>/1-stars.json .. 4-stars.json + stars-map.json
     data/<version>/conflict.json (optional — mutually-exclusive mods)
     data/<version>/presets.json  (optional — built-in preset configs)
   Assigns global sequential IDs to every modifier in array order
   (order is preserved exactly as written — boosts are NOT assumed
   to be sorted). Renders a selectable list, tracks totals, and
   builds/reads shareable permalinks of the form
     ?b=<bitset-packed, base64url selected modifier ids>&cf=<version slug>
   ("b" packs one bit per possible id into bytes then base64url-encodes
   them — length depends only on the highest id in the version, not on
   how many are selected, which keeps the URL short.)
   IDs are only meaningful within the version they came from, which
   is why the version slug travels alongside the selection in every
   permalink and in local storage.

   The URL stays clean (no ?b=/?cf=) during normal browsing. Params
   only appear when: (a) the page was opened via a shared permalink, or
   (b) the user clicks "Copy Permalink". Any further selection change
   after that immediately clears the params again.

   Users can also save/load/rename/delete their own presets (stored in
   IndexedDB, separate from the browser's HTTP/page cache — see the
   "presets" section below) and import/export a single preset as a
   short text code via the Presets panel.

   Data is always fetched fresh (cache: "no-store", no localStorage
   caching of the JSON payload) so editing the JSON files and
   reloading the page always shows the latest content — no need to
   clear the browser cache.
   ============================================================ */

(function () {
  "use strict";

  var TIER_FILES = ["1", "2", "3", "4"];
  var DATA_DIR = "data/";
  var VERSIONS_MANIFEST = DATA_DIR + "versions.json";
  var CONFIG_MIGRATION_URL = DATA_DIR + "config_migration.json";
  var CONFIG_DISABLE_URL = DATA_DIR + "config_disable.json";
  var CONFIG_THEME_URL = DATA_DIR + "config_theme.json";
  var SELECTION_KEY_PREFIX = "mc_selection::"; // + version slug
  var LAST_VERSION_KEY = "mc_last_version";
  var THEME_KEY = "mc_theme";
  var PRESETS_DB_NAME = "modifier_console_db";
  var PRESETS_DB_VERSION = 1;
  var PRESETS_STORE = "presets";

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

  /** built-in presets for the active version: Array<{name, mods:[names]}> */
  var defaultPresets = [];
  /** user-saved presets for the active version, loaded from IndexedDB:
      Array<{id, name, versionSlug, mods:[names], createdAt, updatedAt}> */
  var customPresets = [];

  /** data/config_migration.json: { oldSlug: newSlug, ... } */
  var configMigration = {};
  /** data/config_disable.json: [slug, ...] hidden from the version dropdown */
  var disabledVersions = [];
  /** data/config_theme.json: { default, themes:[{slug,label}] } */
  var themesManifest = { default: "bloxy-red", themes: [{ slug: "bloxy-red", label: "Bloxy Red (Default)" }] };

  var versionsManifest = { default: "", versions: [] };
  var currentVersion = "";
  var readerMode = false;

  var selected = new Set();
  var starMap = { zero: 0, one: 50, two: 150, three: 250, four: 350 };
  var currentTab = "all";
  var copyListFormat = "short";

  /** original (default) meta tag content, captured once at boot so we
      can revert to it when no permalink preview is active */
  var defaultMeta = { description: "", ogTitle: "", ogDescription: "", twitterDescription: "" };

  var els = {};

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    cacheEls();
    captureDefaultMeta();
    detectReaderMode();
    bindGlobalUI();
    requestPersistentStorage();

    Promise.all([
      fetchJSON(VERSIONS_MANIFEST),
      fetchJSONOptional(CONFIG_MIGRATION_URL),
      fetchJSONOptional(CONFIG_DISABLE_URL),
      fetchJSONOptional(CONFIG_THEME_URL)
    ])
      .then(function (results) {
        configMigration = normalizeMigrationMap(results[1]);
        migrateLocalStorageSelections();
        disabledVersions = normalizeDisabledList(results[2]);
        themesManifest = normalizeThemesManifest(results[3]);

        populateThemeSelect();
        applyInitialTheme();

        versionsManifest = normalizeManifest(results[0]);
        populateVersionSelect();
        var initialVersion = resolveInitialVersion();
        var rawCf = new URLSearchParams(window.location.search).get("cf");

        return switchToVersion(initialVersion, { fromURL: true }).then(function () {
          // The URL named an old, since-renamed slug — rewrite the
          // address bar with the canonical one so a bookmarked/shared
          // old link self-corrects, whether or not it also had a ?b=.
          if (rawCf && rawCf !== currentVersion) {
            var isReaderLink = new URLSearchParams(window.location.search).get("reader") === "true";
            setPermalinkURL(isReaderLink);
          }
        });
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
    els.themeSelect = document.getElementById("theme-select");
    els.ogFormatSelect = document.getElementById("og-format-select");
    els.readerCheckbox = document.getElementById("reader-checkbox");
    els.readerBanner = document.getElementById("reader-banner");
    els.readerEditLink = document.getElementById("reader-edit-link");
    els.mastheadSettingsGroup = document.getElementById("masthead-settings-group");
    els.settingsAnchor = document.getElementById("settings-anchor");
    els.mobileSettingsBtn = document.getElementById("mobile-settings-btn");
    els.permalinkBtn = document.getElementById("permalink-btn");
    els.resetBtn = document.getElementById("reset-btn");
    els.popover = document.getElementById("desc-popover");
    els.popoverTitle = document.getElementById("desc-popover-title");
    els.popoverBody = document.getElementById("desc-popover-body");
    els.toast = document.getElementById("toast");

    els.copyListBtn = document.getElementById("copy-list-btn");
    els.copyListFormatWrap = document.getElementById("copy-list-format");
    els.copyListFormatBtns = els.copyListFormatWrap
      ? Array.prototype.slice.call(els.copyListFormatWrap.querySelectorAll(".pill-btn"))
      : [];

    els.presetsList = document.getElementById("presets-list");
    els.savePresetBtn = document.getElementById("save-preset-btn");
    els.exportConfigBtn = document.getElementById("export-config-btn");
    els.importConfigBtn = document.getElementById("import-config-btn");

    els.modalBackdrop = document.getElementById("app-modal-backdrop");
    els.modalTitle = document.getElementById("app-modal-title");
    els.modalBody = document.getElementById("app-modal-body");
    els.modalActions = document.getElementById("app-modal-actions");
    els.modalClose = document.getElementById("app-modal-close");

    els.metaDescription = document.getElementById("meta-description");
    els.metaOgTitle = document.getElementById("og-title");
    els.metaOgDescription = document.getElementById("og-description");
    els.metaTwitterDescription = document.getElementById("twitter-description");
  }

  function captureDefaultMeta() {
    defaultMeta.description = els.metaDescription ? els.metaDescription.getAttribute("content") || "" : "";
    defaultMeta.ogTitle = els.metaOgTitle ? els.metaOgTitle.getAttribute("content") || "" : "";
    defaultMeta.ogDescription = els.metaOgDescription ? els.metaOgDescription.getAttribute("content") || "" : "";
    defaultMeta.twitterDescription = els.metaTwitterDescription
      ? els.metaTwitterDescription.getAttribute("content") || ""
      : "";
  }

  // ?reader=true opens a stripped-down, non-interactive view: just the
  // summary list and star gauge, nothing else. Purely a display mode —
  // it's read once at load, doesn't watch for live changes, and never
  // writes to storage.
  function detectReaderMode() {
    var params = new URLSearchParams(window.location.search);
    readerMode = params.get("reader") === "true";
    document.body.classList.toggle("is-reader-mode", readerMode);
    if (readerMode && els.readerBanner) {
      els.readerBanner.hidden = false;
      if (els.readerEditLink) {
        var url = new URL(window.location.href);
        url.searchParams.delete("reader");
        els.readerEditLink.href = url.toString();
      }
    }
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
      clearURLParams();
      switchToVersion(slug, { fromURL: false, clearSelection: true });
    });

    if (els.themeSelect) {
      els.themeSelect.addEventListener("change", function () {
        var slug = els.themeSelect.value;
        document.documentElement.setAttribute("data-theme", slug);
        writeSavedTheme(slug);
      });
    }

    els.permalinkBtn.addEventListener("click", copyPermalink);
    els.resetBtn.addEventListener("click", resetAll);

    if (els.mobileSettingsBtn) els.mobileSettingsBtn.addEventListener("click", openSettingsModal);

    if (els.copyListFormatBtns.length) {
      els.copyListFormatBtns.forEach(function (btn) {
        btn.addEventListener("click", function () {
          copyListFormat = btn.getAttribute("data-format");
          els.copyListFormatBtns.forEach(function (b) {
            b.classList.toggle("active", b === btn);
          });
        });
      });
    }
    if (els.copyListBtn) els.copyListBtn.addEventListener("click", copyListAsText);

    if (els.savePresetBtn) els.savePresetBtn.addEventListener("click", handleSaveCurrentAsPreset);
    if (els.exportConfigBtn) els.exportConfigBtn.addEventListener("click", handleExportCurrentSelection);
    if (els.importConfigBtn) els.importConfigBtn.addEventListener("click", openImportModal);

    if (els.modalClose) els.modalClose.addEventListener("click", closeModal);
    if (els.modalBackdrop) {
      els.modalBackdrop.addEventListener("click", function (e) {
        if (e.target === els.modalBackdrop) closeModal();
      });
    }

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
      if (e.key === "Escape") {
        els.popover.hidden = true;
        closeModal();
      }
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

  // data/config_disable.json is hidden from the public dropdown only —
  // still directly reachable via ?cf=<slug>, so an in-dev/rewrite
  // version stays testable without being publicly browsable.
  function populateVersionSelect() {
    els.versionSelect.innerHTML = "";
    versionsManifest.versions.forEach(function (v) {
      if (disabledVersions.indexOf(v.slug) !== -1) return;
      var opt = document.createElement("option");
      opt.value = v.slug;
      opt.textContent = v.label || v.slug;
      els.versionSelect.appendChild(opt);
    });
  }

  // If the currently-active version is disabled (someone linked directly
  // to it, e.g. for dev preview), show it in the dropdown anyway while
  // it's active, tagged so it's clear it's not a normal public option.
  function ensureCurrentVersionInSelect(slug) {
    var exists = Array.prototype.some.call(els.versionSelect.options, function (o) {
      return o.value === slug;
    });
    if (exists) return;
    var v = versionsManifest.versions.filter(function (x) { return x.slug === slug; })[0];
    var opt = document.createElement("option");
    opt.value = slug;
    opt.textContent = (v && v.label ? v.label : slug) + " (dev)";
    els.versionSelect.appendChild(opt);
  }

  function resolveInitialVersion() {
    var params = new URLSearchParams(window.location.search);
    var cfRaw = params.get("cf");
    if (cfRaw) {
      var cfResolved = resolveMigratedSlug(cfRaw);
      if (versionExists(cfResolved)) return cfResolved;
    }

    var last = readLastVersion();
    if (last) {
      var lastResolved = resolveMigratedSlug(last);
      if (versionExists(lastResolved)) return lastResolved;
    }

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

  /* ---------------- config_migration.json (renamed version slugs) ---------------- */

  // { "oldSlug": "newSlug", ... } — valid JSON version of the format
  // requested (the original used a bare object-of-key with no value,
  // which isn't valid JSON on its own; this is a plain string map).
  function normalizeMigrationMap(raw) {
    var map = {};
    if (raw && typeof raw === "object") {
      Object.keys(raw).forEach(function (k) {
        if (typeof raw[k] === "string" && raw[k].length) map[k] = raw[k];
      });
    }
    return map;
  }

  // Follows the rename chain (a slug can be renamed more than once
  // across updates) to its final slug. Guards against an accidental
  // cycle in the JSON by never revisiting a slug.
  function resolveMigratedSlug(slug) {
    var seen = {};
    var current = slug;
    while (configMigration[current] && !seen[current]) {
      seen[current] = true;
      current = configMigration[current];
    }
    return current;
  }

  // One-time sweep at boot: if a cached selection exists under an old,
  // since-renamed slug's storage key and nothing exists yet under the
  // new slug's key, move it over. Custom presets are migrated
  // separately, in loadPresetsForVersion(), since that's where their
  // records get read.
  function migrateLocalStorageSelections() {
    try {
      Object.keys(configMigration).forEach(function (oldSlug) {
        var newSlug = resolveMigratedSlug(oldSlug);
        var oldKey = SELECTION_KEY_PREFIX + oldSlug;
        var newKey = SELECTION_KEY_PREFIX + newSlug;
        var oldVal = localStorage.getItem(oldKey);
        if (oldVal !== null && localStorage.getItem(newKey) === null) {
          localStorage.setItem(newKey, oldVal);
        }
        if (oldVal !== null) localStorage.removeItem(oldKey);
      });
    } catch (e) {
      /* localStorage unavailable — nothing to migrate */
    }
  }

  /* ---------------- config_disable.json (hide in-dev versions) ---------------- */

  // Valid JSON version of the format requested (a bare set literal like
  // {"slug", ...} isn't valid JSON) — a plain array of slugs.
  function normalizeDisabledList(raw) {
    return Array.isArray(raw) ? raw.filter(function (s) { return typeof s === "string"; }) : [];
  }

  /* ---------------- config_theme.json (color themes) ---------------- */

  function normalizeThemesManifest(raw) {
    var themes = Array.isArray(raw && raw.themes) ? raw.themes : [];
    themes = themes.filter(function (t) {
      return t && typeof t.slug === "string" && t.slug.length;
    });
    if (!themes.length) {
      themes = [{ slug: "bloxy-red", label: "Bloxy Red (Default)" }];
    }
    var def = raw && raw.default;
    if (!themes.some(function (t) { return t.slug === def; })) {
      def = themes[0].slug;
    }
    return { default: def, themes: themes };
  }

  function populateThemeSelect() {
    if (!els.themeSelect) return;
    els.themeSelect.innerHTML = "";
    themesManifest.themes.forEach(function (t) {
      var opt = document.createElement("option");
      opt.value = t.slug;
      opt.textContent = t.label || t.slug;
      els.themeSelect.appendChild(opt);
    });
  }

  function themeExists(slug) {
    return themesManifest.themes.some(function (t) { return t.slug === slug; });
  }

  function readSavedTheme() {
    try {
      return localStorage.getItem(THEME_KEY);
    } catch (e) {
      return null;
    }
  }

  function writeSavedTheme(slug) {
    try {
      localStorage.setItem(THEME_KEY, slug);
    } catch (e) {
      /* ignore */
    }
  }

  function applyInitialTheme() {
    var saved = readSavedTheme();
    var slug = saved && themeExists(saved) ? saved : themesManifest.default;
    document.documentElement.setAttribute("data-theme", slug);
    if (els.themeSelect) els.themeSelect.value = slug;
  }

  /**
   * Load a version's data, rebuild the registry, and (re)hydrate
   * selection state, then render.
   * options.fromURL        — true on initial page load: honor ?b= for this version
   * options.clearSelection — true when the user manually switches
   *                          versions via the dropdown: start from
   *                          that version's own cached selection (if any)
   */
  function switchToVersion(slug, options) {
    options = options || {};
    currentVersion = slug;
    ensureCurrentVersionInSelect(slug);
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
        return loadPresetsForVersion(slug);
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

        // conflict.json is optional — a version with no conflicts simply
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
  // of rejecting the whole version load — used for the optional
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
  // Order in the array is preserved as-is (boosts are NOT sorted —
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

  // Expected file shape (valid JSON — the format in the original request
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

  /* ---------------- presets: built-in (presets.json) + user (IndexedDB) ---------------- */

  // data/<version>/presets.json is optional:
  //   { "presets": [ { "name": "Speedrun", "mods": ["Mod A", "Mod B"] } ] }
  function normalizeDefaultPresets(raw) {
    var list = Array.isArray(raw && raw.presets) ? raw.presets : [];
    return list
      .filter(function (p) {
        return p && typeof p.name === "string" && p.name.length && Array.isArray(p.mods);
      })
      .map(function (p) {
        return { name: p.name, mods: p.mods.filter(function (m) { return typeof m === "string"; }) };
      });
  }

  // Resolves a preset's stored modifier names to ids in the *current*
  // registry. Names not found in the current version are silently
  // skipped (e.g. a modifier that's since been removed).
  function resolvePresetIds(modNames) {
    var ids = [];
    (modNames || []).forEach(function (name) {
      var entry = registry.filter(function (e) { return e.name === name; })[0];
      if (entry) ids.push(entry.id);
    });
    return ids;
  }

  function loadPresetsForVersion(slug) {
    var dir = DATA_DIR + encodeURIComponent(slug) + "/";
    return Promise.all([fetchJSONOptional(dir + "presets.json"), dbGetAllPresets()]).then(
      function (results) {
        defaultPresets = normalizeDefaultPresets(results[0]);
        var allCustom = Array.isArray(results[1]) ? results[1] : [];

        // Canonicalize any preset saved under a since-renamed version
        // slug (see config_migration.json) — permanently rewritten in
        // IndexedDB so this only has to happen once per preset.
        var matching = [];
        var migrationWrites = [];
        allCustom.forEach(function (p) {
          if (!p) return;
          var resolvedSlug = resolveMigratedSlug(p.versionSlug);
          if (resolvedSlug !== p.versionSlug) {
            p.versionSlug = resolvedSlug;
            migrationWrites.push(dbPutPreset(p));
          }
          if (resolvedSlug === slug) matching.push(p);
        });

        customPresets = matching;
        renderPresets();
        return Promise.all(migrationWrites);
      }
    );
  }

  // --- IndexedDB wrapper for user-saved presets ---
  // Chosen over localStorage because it's what browsers' "clear cache"
  // / "clear cookies" quick-actions target less consistently than the
  // page cache — nothing client-side is bulletproof against a
  // deliberate "clear all site data", though, which is what Export
  // (a portable text code) is for.
  var presetsDbPromise = null;

  function openPresetsDB() {
    if (presetsDbPromise) return presetsDbPromise;
    presetsDbPromise = new Promise(function (resolve, reject) {
      if (!window.indexedDB) {
        reject(new Error("IndexedDB unsupported"));
        return;
      }
      var req = indexedDB.open(PRESETS_DB_NAME, PRESETS_DB_VERSION);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains(PRESETS_STORE)) {
          db.createObjectStore(PRESETS_STORE, { keyPath: "id" });
        }
      };
      req.onsuccess = function (e) { resolve(e.target.result); };
      req.onerror = function (e) { reject(e.target.error); };
    });
    return presetsDbPromise;
  }

  function dbGetAllPresets() {
    return openPresetsDB()
      .then(function (db) {
        return new Promise(function (resolve, reject) {
          var tx = db.transaction(PRESETS_STORE, "readonly");
          var req = tx.objectStore(PRESETS_STORE).getAll();
          req.onsuccess = function () { resolve(req.result || []); };
          req.onerror = function () { reject(req.error); };
        });
      })
      .catch(function () { return []; }); // IndexedDB unavailable — degrade gracefully
  }

  function dbPutPreset(record) {
    return openPresetsDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(PRESETS_STORE, "readwrite");
        tx.objectStore(PRESETS_STORE).put(record);
        tx.oncomplete = function () { resolve(record); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function dbDeletePreset(id) {
    return openPresetsDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(PRESETS_STORE, "readwrite");
        tx.objectStore(PRESETS_STORE).delete(id);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function requestPersistentStorage() {
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().catch(function () { /* best effort */ });
    }
  }

  function generatePresetId() {
    return "p_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
  }

  function renderPresets() {
    if (!els.presetsList) return;
    var combined = defaultPresets
      .map(function (p) { return { source: "default", name: p.name, mods: p.mods }; })
      .concat(
        customPresets.map(function (p) {
          return { source: "custom", id: p.id, name: p.name, mods: p.mods };
        })
      );

    els.presetsList.innerHTML = "";
    if (!combined.length) {
      var empty = document.createElement("p");
      empty.className = "empty-state";
      empty.textContent = "No presets for this version yet.";
      els.presetsList.appendChild(empty);
      return;
    }
    combined.forEach(function (preset) {
      els.presetsList.appendChild(buildPresetRow(preset));
    });
  }

  function buildPresetRow(preset) {
    var row = document.createElement("div");
    row.className = "preset-row";

    var info = document.createElement("div");
    info.className = "preset-info";
    var name = document.createElement("div");
    name.className = "preset-name";
    name.textContent = preset.name;
    var meta = document.createElement("div");
    meta.className = "preset-meta";
    var tag = document.createElement("span");
    tag.className = "preset-tag" + (preset.source === "default" ? " is-default" : "");
    tag.textContent = preset.source === "default" ? "Default" : "Custom";
    meta.appendChild(tag);
    meta.appendChild(document.createTextNode((preset.mods || []).length + " mods"));
    info.appendChild(name);
    info.appendChild(meta);

    var actions = document.createElement("div");
    actions.className = "preset-actions";

    var loadBtn = document.createElement("button");
    loadBtn.type = "button";
    loadBtn.className = "btn btn-ghost btn-small";
    loadBtn.textContent = "Load";
    loadBtn.addEventListener("click", function () { loadPreset(preset); });
    actions.appendChild(loadBtn);

    var exportBtn = document.createElement("button");
    exportBtn.type = "button";
    exportBtn.className = "btn btn-ghost btn-small";
    exportBtn.textContent = "Export";
    exportBtn.addEventListener("click", function () {
      var ids = resolvePresetIds(preset.mods);
      if (!ids.length) {
        showToast("Nothing to export — no matching modifiers");
        return;
      }
      openExportModal(preset.name, buildConfigCode(preset.name, currentVersion, ids));
    });
    actions.appendChild(exportBtn);

    if (preset.source === "custom") {
      var renameBtn = document.createElement("button");
      renameBtn.type = "button";
      renameBtn.className = "btn btn-ghost btn-small";
      renameBtn.textContent = "Rename";
      renameBtn.addEventListener("click", function () {
        openNameModal("Rename Preset", preset.name, function (newName) {
          var record = customPresets.filter(function (p) { return p.id === preset.id; })[0];
          if (!record) return;
          record.name = newName;
          record.updatedAt = Date.now();
          dbPutPreset(record).then(function () {
            renderPresets();
            showToast("Preset renamed");
          });
        });
      });
      actions.appendChild(renameBtn);

      var deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "btn btn-ghost btn-small btn-danger";
      deleteBtn.textContent = "Delete";
      deleteBtn.addEventListener("click", function () {
        if (!window.confirm('Delete preset "' + preset.name + '"? This cannot be undone.')) return;
        dbDeletePreset(preset.id).then(function () {
          customPresets = customPresets.filter(function (p) { return p.id !== preset.id; });
          renderPresets();
          showToast("Preset deleted");
        });
      });
      actions.appendChild(deleteBtn);
    }

    row.appendChild(info);
    row.appendChild(actions);
    return row;
  }

  function loadPreset(preset) {
    var ids = resolvePresetIds(preset.mods);
    if (!ids.length) {
      showToast("No matching modifiers in this version");
      return;
    }
    selected = new Set(ids);
    persistSelection();
    clearURLParams();
    renderList();
    renderSummary();
    showToast('Loaded "' + preset.name + '"');
  }

  function handleSaveCurrentAsPreset() {
    if (!selected.size) {
      showToast("Nothing selected to save");
      return;
    }
    openNameModal("Save Preset", "", function (name) {
      var mods = Array.from(selected)
        .map(function (id) { return byId[id] ? byId[id].name : null; })
        .filter(Boolean);
      var record = {
        id: generatePresetId(),
        name: name,
        versionSlug: currentVersion,
        mods: mods,
        createdAt: Date.now()
      };
      dbPutPreset(record)
        .then(function () {
          customPresets.push(record);
          renderPresets();
          showToast('Preset "' + name + '" saved');
        })
        .catch(function () {
          showToast("Couldn't save preset — storage unavailable");
        });
    });
  }

  function handleExportCurrentSelection() {
    if (!selected.size) {
      showToast("Nothing selected to export");
      return;
    }
    openNameModal("Export Config", "", function (name) {
      var ids = Array.from(selected);
      openExportModal(name, buildConfigCode(name, currentVersion, ids));
    });
  }

  /* ---------------- import/export config codes ---------------- */

  // Format: <base64url(name)>.<base64url(version slug)>:<bitset code>
  // "." and ":" never appear inside base64url output, so this splits
  // unambiguously even though the name/slug/code segments themselves
  // can (and often will) contain "-" and "_".
  function utf8ToB64Url(str) {
    var bytes = new TextEncoder().encode(str);
    var binary = "";
    bytes.forEach(function (b) { binary += String.fromCharCode(b); });
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function b64UrlToUtf8(b64) {
    var binary = atob(b64.replace(/-/g, "+").replace(/_/g, "/"));
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  function buildConfigCode(name, slug, ids) {
    var sortedIds = ids.slice().sort(function (a, b) { return a - b; });
    return utf8ToB64Url(name) + "." + utf8ToB64Url(slug) + ":" + encodeSequence(sortedIds);
  }

  function parseConfigCode(code) {
    var colonIdx = code.indexOf(":");
    if (colonIdx === -1) return null;
    var header = code.slice(0, colonIdx);
    var idsPart = code.slice(colonIdx + 1);
    var dotIdx = header.indexOf(".");
    if (dotIdx === -1) return null;
    try {
      var name = b64UrlToUtf8(header.slice(0, dotIdx));
      var slug = b64UrlToUtf8(header.slice(dotIdx + 1));
      if (!name || !slug) return null;
      return { name: name, slug: slug, ids: decodeSequence(idsPart) };
    } catch (e) {
      return null;
    }
  }

  function openImportModal() {
    openModal("Import Config", function (body, actions, close) {
      var field = document.createElement("div");
      field.className = "modal-field";
      var label = document.createElement("label");
      label.className = "modal-field-label";
      label.textContent = "Paste config code";
      var ta = document.createElement("textarea");
      ta.className = "modal-textarea";
      ta.placeholder = "name.version:code";
      field.appendChild(label);
      field.appendChild(ta);

      var help = document.createElement("div");
      help.className = "modal-help";
      help.textContent =
        "Switches to the matching version if needed, applies the selection, and saves it as a new preset.";

      body.appendChild(field);
      body.appendChild(help);

      var cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "btn btn-ghost";
      cancelBtn.textContent = "Cancel";
      cancelBtn.addEventListener("click", close);

      var importBtn = document.createElement("button");
      importBtn.type = "button";
      importBtn.className = "btn btn-ghost";
      importBtn.textContent = "Import";
      importBtn.addEventListener("click", function () {
        var raw = ta.value.trim();
        if (!raw) return;
        close();
        applyImportedConfig(raw);
      });

      actions.appendChild(cancelBtn);
      actions.appendChild(importBtn);
      setTimeout(function () { ta.focus(); }, 0);
    });
  }

  function applyImportedConfig(raw) {
    var parsed = parseConfigCode(raw);
    if (!parsed) {
      showToast("Invalid config code");
      return;
    }
    if (!versionExists(parsed.slug)) {
      showToast('Unknown version in code: "' + parsed.slug + '"');
      return;
    }

    var proceed = function () {
      var validIds = parsed.ids.filter(function (id) { return !!byId[id]; });
      if (!validIds.length) {
        showToast("Config code matched no modifiers in this version");
        return;
      }
      selected = new Set(validIds);
      persistSelection();
      clearURLParams();
      renderList();
      renderSummary();

      var modNames = validIds.map(function (id) { return byId[id].name; });
      var record = {
        id: generatePresetId(),
        name: parsed.name,
        versionSlug: currentVersion,
        mods: modNames,
        createdAt: Date.now()
      };
      dbPutPreset(record)
        .then(function () {
          customPresets.push(record);
          renderPresets();
          showToast('Imported "' + parsed.name + '" and saved as a preset');
        })
        .catch(function () {
          showToast('Imported "' + parsed.name + '" (preset save failed)');
        });
    };

    if (parsed.slug !== currentVersion) {
      switchToVersion(parsed.slug, { fromURL: false, clearSelection: true }).then(proceed);
    } else {
      proceed();
    }
  }

  /* ---------------- generic modal (save/rename/export/import) ---------------- */

  function openModal(title, renderFn) {
    if (!els.modalBackdrop) return;
    els.modalTitle.textContent = title;
    els.modalBody.innerHTML = "";
    els.modalActions.innerHTML = "";
    renderFn(els.modalBody, els.modalActions, closeModal);
    els.modalBackdrop.hidden = false;
  }

  function closeModal() {
    // If the mobile Settings modal is open, it borrowed the live
    // settings controls by moving them into modalBody (not cloning —
    // same nodes, same listeners) — move them back to the masthead
    // before hiding, so they're usable again in their normal spot.
    if (
      els.mastheadSettingsGroup &&
      els.settingsAnchor &&
      els.mastheadSettingsGroup.parentNode === els.modalBody
    ) {
      els.settingsAnchor.insertAdjacentElement("afterend", els.mastheadSettingsGroup);
    }
    if (els.modalBackdrop) els.modalBackdrop.hidden = true;
  }

  // Mobile only (see the 640px media query): collapses Version/Theme/
  // Preview/Read-Only into a single button so the masthead doesn't
  // have to fit six controls on one row. Reparents the real, live
  // controls into the modal rather than rebuilding them, so there's
  // no separate mobile copy to keep in sync.
  function openSettingsModal() {
    openModal("Settings", function (body, actions, close) {
      body.appendChild(els.mastheadSettingsGroup);
      var doneBtn = document.createElement("button");
      doneBtn.type = "button";
      doneBtn.className = "btn btn-ghost";
      doneBtn.textContent = "Done";
      doneBtn.addEventListener("click", close);
      actions.appendChild(doneBtn);
    });
  }

  function openNameModal(title, initialValue, onConfirm) {
    openModal(title, function (body, actions, close) {
      var field = document.createElement("div");
      field.className = "modal-field";
      var label = document.createElement("label");
      label.className = "modal-field-label";
      label.textContent = "Name";
      var input = document.createElement("input");
      input.type = "text";
      input.className = "modal-input";
      input.maxLength = 60;
      input.value = initialValue || "";
      field.appendChild(label);
      field.appendChild(input);
      body.appendChild(field);

      var cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "btn btn-ghost";
      cancelBtn.textContent = "Cancel";
      cancelBtn.addEventListener("click", close);

      var confirmBtn = document.createElement("button");
      confirmBtn.type = "button";
      confirmBtn.className = "btn btn-ghost";
      confirmBtn.textContent = "Save";
      var submit = function () {
        var val = input.value.trim();
        if (!val) {
          input.focus();
          return;
        }
        close();
        onConfirm(val);
      };
      confirmBtn.addEventListener("click", submit);
      input.addEventListener("keydown", function (e) {
        if (e.key === "Enter") submit();
      });

      actions.appendChild(cancelBtn);
      actions.appendChild(confirmBtn);
      setTimeout(function () { input.focus(); input.select(); }, 0);
    });
  }

  function openExportModal(name, code) {
    openModal("Export Config", function (body, actions, close) {
      var field = document.createElement("div");
      field.className = "modal-field";
      var label = document.createElement("label");
      label.className = "modal-field-label";
      label.textContent = 'Config code for "' + name + '"';
      var ta = document.createElement("textarea");
      ta.className = "modal-textarea";
      ta.readOnly = true;
      ta.value = code;
      field.appendChild(label);
      field.appendChild(ta);

      var help = document.createElement("div");
      help.className = "modal-help";
      help.textContent = "Share this code — anyone can paste it into Import Config to load these exact mods.";

      body.appendChild(field);
      body.appendChild(help);

      var closeBtn = document.createElement("button");
      closeBtn.type = "button";
      closeBtn.className = "btn btn-ghost";
      closeBtn.textContent = "Close";
      closeBtn.addEventListener("click", close);

      var copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "btn btn-ghost";
      copyBtn.textContent = "Copy Code";
      copyBtn.addEventListener("click", function () {
        ta.focus();
        ta.select();
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard
            .writeText(code)
            .then(function () { showToast("Code copied"); })
            .catch(function () { showToast("Copy failed — select & copy manually"); });
        } else {
          showToast("Select & copy manually");
        }
      });

      actions.appendChild(closeBtn);
      actions.appendChild(copyBtn);
      setTimeout(function () { ta.focus(); ta.select(); }, 0);
    });
  }

  /* ---------------- shareable mod-list text (Copy List + permalink preview) ---------------- */

  function selectedEntriesSorted() {
    return Array.from(selected)
      .map(function (id) { return byId[id]; })
      .filter(Boolean)
      .sort(function (a, b) { return a.id - b.id; });
  }

  // "1 Star(s) Modifier\n\n* Mod — boost%\n...\n\n2 Star(s) Modifier\n..."
  // Tiers with nothing selected are skipped entirely.
  function buildLongList() {
    var entries = selectedEntriesSorted();
    var lines = [];
    TIER_FILES.forEach(function (tier) {
      var tierEntries = entries.filter(function (e) { return e.tier === tier; });
      if (!tierEntries.length) return;
      lines.push(tier + " Star(s) Modifier");
      lines.push("");
      tierEntries.forEach(function (e) {
        lines.push("* " + e.name + " \u2014 " + e.boost + "%");
      });
      lines.push("");
    });
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    return lines.join("\n");
  }

  // "mod; mod; mod" — no trailing separator.
  function buildShortList() {
    return selectedEntriesSorted().map(function (e) { return e.name; }).join("; ");
  }

  function currentStarCount(totalBoost) {
    var bands = [
      { n: 0, val: Number(starMap.zero) || 0 },
      { n: 1, val: Number(starMap.one) || 0 },
      { n: 2, val: Number(starMap.two) || 0 },
      { n: 3, val: Number(starMap.three) || 0 },
      { n: 4, val: Number(starMap.four) || 0 }
    ];
    var current = bands[0];
    bands.forEach(function (b) { if (totalBoost >= b.val) current = b; });
    return current.n;
  }

  function buildSummaryLine() {
    var entries = selectedEntriesSorted();
    var totalBoost = entries.reduce(function (sum, e) { return sum + e.boost; }, 0);
    return "Mods: " + entries.length + " || Percentage: " + totalBoost + "% = " + currentStarCount(totalBoost) + " star(s)";
  }

  // Copy List never includes the "// Summary" line — only the OG
  // permalink preview does.
  function copyListAsText() {
    if (!selected.size) {
      showToast("No modifiers selected");
      return;
    }
    var text = copyListFormat === "long" ? buildLongList() : buildShortList();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard
        .writeText(text)
        .then(function () { showToast("List copied"); })
        .catch(function () { showToast("Copy failed"); });
    } else {
      showToast("Copy failed — clipboard unavailable");
    }
  }

  /* ---------------- permalink preview meta tags (local tab only — see README) ---------------- */

  function setMetaContent(el, content) {
    if (el) el.setAttribute("content", content);
  }

  function applyOgFormat(format) {
    if (format === "none" || !selected.size) {
      setMetaContent(els.metaDescription, defaultMeta.description);
      setMetaContent(els.metaOgDescription, defaultMeta.ogDescription);
      setMetaContent(els.metaTwitterDescription, defaultMeta.twitterDescription);
      return;
    }
    var desc =
      format === "long"
        ? buildLongList() + "\n\n// Summary\n" + buildSummaryLine()
        : buildShortList() + "\n\n" + buildSummaryLine();
    setMetaContent(els.metaDescription, desc);
    setMetaContent(els.metaOgDescription, desc);
    setMetaContent(els.metaTwitterDescription, desc);
  }

  /* ---------------- selection state (namespaced per version) ---------------- */

  function hydrateSelectionFromURLOrCache(slug) {
    var params = new URLSearchParams(window.location.search);
    var b = params.get("b");
    var cfRaw = params.get("cf");
    var cf = cfRaw ? resolveMigratedSlug(cfRaw) : null;

    // Only trust ?b= for the version it was generated against (after
    // resolving any rename via config_migration.json).
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
    // Note: the URL is NOT touched here. Only "Copy Permalink" writes
    // ?b=/?cf= to the address bar; every other selection change keeps
    // the URL clean (see clearURLParams()).
  }

  // Writes the current selection + version into the address bar as a
  // permalink. Only called explicitly from the Copy Permalink button.
  function setPermalinkURL(isReaderLink) {
    var url = new URL(window.location.href);
    url.searchParams.set("cf", currentVersion);
    if (selected.size) {
      var ids = Array.from(selected).sort(function (a, b) { return a - b; });
      url.searchParams.set("b", encodeSequence(ids));
    } else {
      url.searchParams.delete("b");
    }
    if (isReaderLink) {
      url.searchParams.set("reader", "true");
    } else {
      url.searchParams.delete("reader");
    }
    window.history.replaceState({}, "", url.toString());
  }

  // Strips ?b=/?cf=/?reader= from the address bar and reverts any
  // permalink preview meta tags back to their defaults. Called whenever
  // the live selection/version diverges from whatever permalink might
  // currently be shown in the URL, so the bar only ever shows params
  // that accurately describe what's on screen.
  function clearURLParams() {
    var url = new URL(window.location.href);
    if (url.searchParams.has("b") || url.searchParams.has("cf") || url.searchParams.has("reader")) {
      url.searchParams.delete("b");
      url.searchParams.delete("cf");
      url.searchParams.delete("reader");
      window.history.replaceState({}, "", url.toString());
    }
    applyOgFormat("none");
  }

  // Bitset encoding: one bit per possible modifier id (bit n set = id n
  // selected), packed into bytes, then base64url'd. Cost is fixed at
  // ceil((maxId+1)/8) bytes regardless of how many ids are selected —
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
    clearURLParams();
    renderList();
    renderSummary();
  }

  function resetAll() {
    selected = new Set();
    persistSelection();
    clearURLParams();
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
        showToast("Conflicts with " + names.join(", ") + " — deselect it first");
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
    var isReaderLink = !!(els.readerCheckbox && els.readerCheckbox.checked);
    setPermalinkURL(isReaderLink);
    applyOgFormat(els.ogFormatSelect ? els.ogFormatSelect.value : "none");
    var url = window.location.href;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard
        .writeText(url)
        .then(function () { showToast(isReaderLink ? "Read-only permalink copied" : "Permalink copied"); })
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
