/*
 * patternlab-node https://github.com/pattern-lab/patternlab-node
 *
 * Brian Muenzenmeyer, Geoff Pursell, Raphael Okon, tburny and the web community.
 * Licensed under the MIT license.
 *
 * Many thanks to Brad Frost and Dave Olsen for inspiration, encouragement, and advice.
 *
 */

"use strict";

const diveSync = require('diveSync');
const dive = require('dive');
const _ = require('lodash');
const path = require('path');
const chalk = require('chalk');
const cleanHtml = require('js-beautify').html;
const inherits = require('util').inherits;
const pm = require('./plugin_manager');
const packageInfo = require('../../package.json');
const dataLoader = require('./data_loader')();
const plutils = require('./utilities');
const jsonCopy = require('./json_copy');
const PatternGraph = require('./pattern_graph').PatternGraph;
const pa = require('./pattern_assembler');
const lh = require('./lineage_hunter');
const sm = require('./starterkit_manager');
const pe = require('./pattern_exporter');
const Pattern = require('./object_factory').Pattern;
const CompileState = require('./object_factory').CompileState;
const updateNotifier = require('update-notifier');

//these are mocked in unit tests, so let them be overridden
let fs = require('fs-extra'); // eslint-disable-line
let ui_builder = require('./ui_builder'); // eslint-disable-line
let pattern_exporter = new pe(); // eslint-disable-line
let assetCopier = require('./asset_copy'); // eslint-disable-line
let serve = require('./serve'); // eslint-disable-line

const pattern_assembler = new pa();
const lineage_hunter = new lh();

//register our log events
plutils.log.on('error', msg => console.log(msg));
plutils.log.on('debug', msg => console.log(msg));
plutils.log.on('warning', msg => console.log(msg));
plutils.log.on('info', msg => console.log(msg));

const patternEngines = require('./pattern_engines');
const EventEmitter = require('events').EventEmitter;

//bootstrap update notifier
updateNotifier({
  pkg: packageInfo,
  updateCheckInterval: 1000 * 60 * 60 * 24 // notify at most once a day
}).notify();

/**
 * Given a path, load info from the folder to compile into a single config object.
 * @param dataFilesPath
 * @param fsDep
 * @returns {{}}
 */
function buildPatternData(dataFilesPath, fsDep) {
  return dataLoader.loadDataFromFolder(dataFilesPath, 'listitems', fsDep);
}

// GTP: these two diveSync pattern processors factored out so they can be reused
// from unit tests to reduce code dupe!
function processAllPatternsIterative(patterns_dir, patternlab) {

  const promiseAllPatternFiles = new Promise(function (resolve) {
    dive(
      patterns_dir,
      (err, file) => {
        //log any errors
        if (err) {
          console.log('error in processAllPatternsIterative():', err);
          return;
        }

        // We now have the loading and process phases spearated; this
        // loads all the patterns before beginning any analysis, so we
        // can load them asynchronously and be sure we know about all
        // of them before we start lineage hunting, for
        // example. Incidentally, this should also allow people to do
        // horrifying things like include a page in a atom. But
        // please, if you're reading this: don't.

        // NOTE: sync for now
        pattern_assembler.load_pattern_iterative(path.relative(patterns_dir, file), patternlab);
      },
      resolve
    );
  });
  return promiseAllPatternFiles.then(() => {
    // This is the second phase: once we've loaded all patterns,
    // start analysis.
    // patternlab.patterns.forEach((pattern) => {
    //   pattern_assembler.process_pattern_iterative(pattern, patternlab);
    // });
    return Promise.all(patternlab.patterns.map((pattern) => {
      return pattern_assembler.process_pattern_iterative(pattern, patternlab);
    }));
  });
}

function processAllPatternsRecursive(patterns_dir, patternlab) {
  diveSync(
    patterns_dir,
    function (err, file) {
      //log any errors
      if (err) {
        console.log(err);
        return;
      }
      pattern_assembler.process_pattern_recursive(path.relative(patterns_dir, file), patternlab);
    }
  );
}

function checkConfiguration(patternlab) {
  //default the output suffixes if not present
  const outputFileSuffixes = {
    rendered: '.rendered',
    rawTemplate: '',
    markupOnly: '.markup-only'
  };

  if (!patternlab.config.outputFileSuffixes) {
    plutils.warning('Configuration Object "outputFileSuffixes" not found, and defaulted to the following:');
    console.log(outputFileSuffixes);
    plutils.warning('Since Pattern Lab Node Core 2.3.0 this configuration option is required. Suggest you add it to your patternlab-config.json file.');
    console.log();
  }
  patternlab.config.outputFileSuffixes = _.extend(outputFileSuffixes, patternlab.config.outputFileSuffixes);

  if (typeof patternlab.config.paths.source.patternlabFiles === 'string') {
    plutils.warning(`Configuration key [paths.source.patternlabFiles] inside patternlab-config.json was found as the string '${patternlab.config.paths.source.patternlabFiles}'`);
    plutils.warning('Since Pattern Lab Node Core 3.0.0 this key is an object. Suggest you update this key following this issue: https://github.com/pattern-lab/patternlab-node/issues/683.');
  }

}

/**
 * Finds and calls the main method of any found plugins.
 * @param patternlab - global data store
 */

//todo, move this to plugin_manager
function initializePlugins(patternlab) {

  if (!patternlab.config.plugins) { return; }

  const plugin_manager = new pm(patternlab.config, path.resolve(__dirname, '../../patternlab-config.json'));
  const foundPlugins = plugin_manager.detect_plugins();

  if (foundPlugins && foundPlugins.length > 0) {

    for (let i = 0; i < foundPlugins.length; i++) {

      const pluginKey = foundPlugins[i];

      if (patternlab.config.debug) {
        console.log('Found plugin: ', pluginKey);
        console.log('Attempting to load and initialize plugin.');
      }

      const plugin = plugin_manager.load_plugin(pluginKey);
      plugin(patternlab);
    }
  }
}

/**
 * Installs a given plugin. Assumes it has already been pulled down via npm
 * @param pluginName - the name of the plugin
 */
function installPlugin(pluginName) {
  //get the config
  const configPath = path.resolve(process.cwd(), 'patternlab-config.json');
  const config = fs.readJSONSync(path.resolve(configPath), 'utf8');
  const plugin_manager = new pm(config, configPath);

  plugin_manager.install_plugin(pluginName);
}

function PatternLabEventEmitter() {
  EventEmitter.call(this);
}
inherits(PatternLabEventEmitter, EventEmitter);

const patternlab_engine = function (config) {
  const patternlab = {};

  patternlab.engines = patternEngines;
  patternlab.engines.loadAllEngines(config);

  patternlab.package = fs.readJSONSync(path.resolve(__dirname, '../../package.json'));
  patternlab.config = config || fs.readJSONSync(path.resolve(__dirname, '../../patternlab-config.json'));
  patternlab.events = new PatternLabEventEmitter();
  patternlab.watchers = {};

  // Initialized when building
  patternlab.graph = null;

  checkConfiguration(patternlab);

  //todo: determine if this is the best place to wire up plugins
  initializePlugins(patternlab);

  const paths = patternlab.config.paths;

  function getVersion() {
    return patternlab.package.version;
  }

  function logVersion() {
    console.log(patternlab.package.version);
  }

  function getSupportedTemplateExtensions() {
    return patternlab.engines.getSupportedFileExtensions();
  }

  function help() {

    console.log('');

    console.log('|=======================================|');
    plutils.debug('     Pattern Lab Node Help v' + patternlab.package.version);
    console.log('|=======================================|');

    console.log('');
    console.log('Command Line Interface - usually consumed by an edition');
    console.log('');

    plutils.debug(' patternlab:build');
    console.log('   > Compiles the patterns and frontend, outputting to config.paths.public');
    console.log('');

    plutils.debug(' patternlab:patternsonly');
    console.log('   > Compiles the patterns only, outputting to config.paths.public');
    console.log('');

    plutils.debug(' patternlab:version');
    console.log('   > Return the version of patternlab-node you have installed');
    console.log('');

    plutils.debug(' patternlab:help');
    console.log('   > Get more information about patternlab-node, pattern lab in general, and where to report issues.');
    console.log('');

    plutils.debug(' patternlab:liststarterkits');
    console.log('   > Returns a url with the list of available starterkits hosted on the Pattern Lab organization Github account');
    console.log('');

    plutils.debug(' patternlab:loadstarterkit');
    console.log('   > Load a starterkit into config.paths.source/*');
    console.log('   > NOTE: Overwrites existing content, and only cleans out existing directory if --clean=true argument is passed.');
    console.log('   > NOTE: In most cases, `npm install starterkit-name` will precede this call.');
    console.log('   > arguments:');
    console.log('      -- kit ');
    console.log('      > the name of the starter kit to load');
    console.log('      -- clean ');
    console.log('      > removes all files from config.paths.source/ prior to load');
    console.log('   > example (gulp):');
    console.log('    `gulp patternlab:loadstarterkit --kit=starterkit-mustache-demo`');
    console.log('');

    console.log('===============================');
    console.log('');
    console.log('Visit http://patternlab.io/ for more info about Pattern Lab');
    console.log('Visit https://github.com/pattern-lab/patternlab-node/issues to open an issue.');
    console.log('Visit https://github.com/pattern-lab/patternlab-node/wiki to view the changelog, roadmap, and other info.');
    console.log('');
    console.log('===============================');
  }

  function printDebug() {
    // A replacer function to pass to stringify below; this is here to prevent
    // the debug output from blowing up into a massive fireball of circular
    // references. This happens specifically with the Handlebars engine. Remove
    // if you like 180MB log files.
    function propertyStringReplacer(key, value) {
      if (key === 'engine' && value && value.engineName) {
        return '{' + value.engineName + ' engine object}';
      }
      return value;
    }

    //debug file can be written by setting flag on patternlab-config.json
    if (patternlab.config.debug) {
      console.log('writing patternlab debug file to ./patternlab.json');
      fs.outputFileSync('./patternlab.json', JSON.stringify(patternlab, propertyStringReplacer, 3));
    }
  }

  function setCacheBust() {
    if (patternlab.config.cacheBust) {
      if (patternlab.config.debug) {
        console.log('setting cacheBuster value for frontend assets.');
      }
      patternlab.cacheBuster = new Date().getTime();
    } else {
      patternlab.cacheBuster = 0;
    }
  }

  function listStarterkits() {
    const starterkit_manager = new sm(patternlab.config);
    return starterkit_manager.list_starterkits();
  }

  function loadStarterKit(starterkitName, clean) {
    const starterkit_manager = new sm(patternlab.config);
    starterkit_manager.load_starterkit(starterkitName, clean);
  }

  /**
   * Process the user-defined pattern head and prepare it for rendering
   */
  function processHeadPattern() {
    try {
      const headPath = path.resolve(paths.source.meta, '_00-head.mustache');
      const headPattern = new Pattern(headPath, null, patternlab);
      headPattern.template = fs.readFileSync(headPath, 'utf8');
      headPattern.isPattern = false;
      headPattern.isMetaPattern = true;
      pattern_assembler.decomposePattern(headPattern, patternlab, true);
      patternlab.userHead = headPattern.extendedTemplate;
    }
    catch (ex) {
      plutils.error('\nWARNING: Could not find the user-editable header template, currently configured to be at ' + path.join(config.paths.source.meta, '_00-head.mustache') + '. Your configured path may be incorrect (check paths.source.meta in your config file), the file may have been deleted, or it may have been left in the wrong place during a migration or update.\n');
      if (patternlab.config.debug) { console.log(ex); }
      process.exit(1);
    }
  }

  /**
   * Process the user-defined pattern footer and prepare it for rendering
   */
  function processFootPattern() {
    try {
      const footPath = path.resolve(paths.source.meta, '_01-foot.mustache');
      const footPattern = new Pattern(footPath, null, patternlab);
      footPattern.template = fs.readFileSync(footPath, 'utf8');
      footPattern.isPattern = false;
      footPattern.isMetaPattern = true;
      pattern_assembler.decomposePattern(footPattern, patternlab, true);
      patternlab.userFoot = footPattern.extendedTemplate;
    }
    catch (ex) {
      plutils.error('\nWARNING: Could not find the user-editable footer template, currently configured to be at ' + path.join(config.paths.source.meta, '_01-foot.mustache') + '. Your configured path may be incorrect (check paths.source.meta in your config file), the file may have been deleted, or it may have been left in the wrong place during a migration or update.\n');
      if (patternlab.config.debug) { console.log(ex); }
      process.exit(1);
    }
  }

  function writePatternFiles(headHTML, pattern, footerHTML) {
    const nullFormatter = str => str;
    const defaultFormatter = codeString => cleanHtml(codeString, {indent_size: 2});
    const makePath = type => path.join(paths.public.patterns, pattern.getPatternLink(patternlab, type));
    const patternPage = headHTML + pattern.patternPartialCode + footerHTML;
    const eng = pattern.engine;

    //beautify the output if configured to do so
    const formatters = config.cleanOutputHtml ? {
      rendered:     eng.renderedCodeFormatter || defaultFormatter,
      rawTemplate:  eng.rawTemplateCodeFormatter || defaultFormatter,
      markupOnly:   eng.markupOnlyCodeFormatter || defaultFormatter
    } : {
      rendered:     nullFormatter,
      rawTemplate:  nullFormatter,
      markupOnly:   nullFormatter
    };

    //prepare the path and contents of each output file
    const outputFiles = [
      { path: makePath('rendered'), content: formatters.rendered(patternPage, pattern) },
      { path: makePath('rawTemplate'), content: formatters.rawTemplate(pattern.template, pattern) },
      { path: makePath('markupOnly'), content: formatters.markupOnly(pattern.patternPartialCode, pattern) }
    ].concat(
      eng.addOutputFiles ? eng.addOutputFiles(paths, patternlab) : []
    );

    //write the compiled template to the public patterns directory
    outputFiles.forEach(outFile => fs.outputFileSync(outFile.path, outFile.content));
  }

  function renderSinglePattern(pattern, head) {
    // Pattern does not need to be built and recompiled more than once
    if (!pattern.isPattern || pattern.compileState === CompileState.CLEAN) {
      return false;
    }

    // Allows serializing the compile state
    patternlab.graph.node(pattern).compileState = pattern.compileState = CompileState.BUILDING;

    //todo move this into lineage_hunter
    pattern.patternLineages = pattern.lineage;
    pattern.patternLineageExists = pattern.lineage.length > 0;
    pattern.patternLineagesR = pattern.lineageR;
    pattern.patternLineageRExists = pattern.lineageR.length > 0;
    pattern.patternLineageEExists = pattern.patternLineageExists || pattern.patternLineageRExists;

    patternlab.events.emit('patternlab-pattern-before-data-merge', patternlab, pattern);

    //render the pattern, but first consolidate any data we may have
    let allData;
    try {
      allData = jsonCopy(patternlab.data, 'config.paths.source.data global data');
    } catch (err) {
      console.log('There was an error parsing JSON for ' + pattern.relPath);
      console.log(err);
    }
    allData = _.merge(allData, pattern.jsonFileData);
    allData.cacheBuster = patternlab.cacheBuster;

    //re-rendering the headHTML each time allows pattern-specific data to influence the head of the pattern
    pattern.header = head;
    const headHTML = pattern_assembler.renderPattern(pattern.header, allData);

    //render the extendedTemplate with all data
    pattern.patternPartialCode = pattern_assembler.renderPattern(pattern, allData);

    // stringify this data for individual pattern rendering and use on the styleguide
    // see if patternData really needs these other duped values

    // construct our extraOutput dump
    var extraOutput = Object.assign({}, pattern.extraOutput, pattern.allMarkdown);
    delete(extraOutput.title);
    delete(extraOutput.state);
    delete(extraOutput.markdown);

    pattern.patternData = JSON.stringify({
      cssEnabled: false,
      patternLineageExists: pattern.patternLineageExists,
      patternLineages: pattern.patternLineages,
      lineage: pattern.patternLineages,
      patternLineageRExists: pattern.patternLineageRExists,
      patternLineagesR: pattern.patternLineagesR,
      lineageR: pattern.patternLineagesR,
      patternLineageEExists: pattern.patternLineageExists || pattern.patternLineageRExists,
      patternDesc: pattern.patternDescExists ? pattern.patternDesc : '',
      patternBreadcrumb:
        pattern.patternGroup === pattern.patternSubGroup ? {
          patternType: pattern.patternGroup
        } : {
          patternType: pattern.patternGroup,
          patternSubtype: pattern.patternSubGroup
        },
      patternExtension: pattern.fileExtension.substr(1), //remove the dot because styleguide asset default adds it for us
      patternName: pattern.patternName,
      patternPartial: pattern.patternPartial,
      patternState: pattern.patternState,
      patternEngineName: pattern.engine.engineName,
      extraOutput: extraOutput
    });

    //set the pattern-specific footer by compiling the general-footer with data, and then adding it to the meta footer
    const footerPartial = pattern_assembler.renderPattern(patternlab.footer, {
      isPattern: pattern.isPattern,
      patternData: pattern.patternData,
      cacheBuster: patternlab.cacheBuster
    });

    let allFooterData;
    try {
      allFooterData = jsonCopy(patternlab.data, 'config.paths.source.data global data');
    } catch (err) {
      console.log('There was an error parsing JSON for ' + pattern.relPath);
      console.log(err);
    }
    allFooterData = _.merge(allFooterData, pattern.jsonFileData);
    allFooterData.patternLabFoot = footerPartial;

    const footerHTML = pattern_assembler.renderPattern(patternlab.userFoot, allFooterData);

    patternlab.events.emit('patternlab-pattern-write-begin', patternlab, pattern);

    //write the compiled template to the public patterns directory
    writePatternFiles(headHTML, pattern, footerHTML);

    patternlab.events.emit('patternlab-pattern-write-end', patternlab, pattern);

    // Allows serializing the compile state
    patternlab.graph.node(pattern).compileState = pattern.compileState = CompileState.CLEAN;
    plutils.log.info("Built pattern: " + pattern.patternPartial);
    return true;
  }

  /**
   * If a graph was serialized and then {@code deletePatternDir == true}, there is a mismatch in the
   * pattern metadata and not all patterns might be recompiled.
   * For that reason an empty graph is returned in this case, so every pattern will be flagged as
   * "needs recompile". Otherwise the pattern graph is loaded from the meta data.
   *
   * @param patternlab
   * @param {boolean} deletePatternDir When {@code true}, an empty graph is returned
   * @return {PatternGraph}
   */
  function loadPatternGraph(deletePatternDir) {
    // Sanity check to prevent problems when code is refactored
    if (deletePatternDir) {
      return PatternGraph.empty();
    }
    return PatternGraph.loadFromFile(patternlab);
  }

  function buildPatterns(deletePatternDir) {

    if (patternlab.config.debug) {
      console.log(
        chalk.bold('\n====[ Pattern Lab / Node'),
        `- v${packageInfo.version}`,
        chalk.bold(']====\n')
      );
    }

    patternlab.events.emit('patternlab-build-pattern-start', patternlab);

    const graph = patternlab.graph = loadPatternGraph(deletePatternDir);

    const graphNeedsUpgrade = !PatternGraph.checkVersion(graph);

    if (graphNeedsUpgrade) {
      plutils.log.info("Due to an upgrade, a complete rebuild is required and the public/patterns directory was deleted. " +
                       "Incremental build is available again on the next successful run.");

      // Ensure that the freshly built graph has the latest version again.
      patternlab.graph.upgradeVersion();
    }

    // Flags
    const incrementalBuildsEnabled = !(deletePatternDir || graphNeedsUpgrade);

    if (incrementalBuildsEnabled) {
      plutils.log.info("Incremental builds enabled.");
    } else {
      // needs to be done BEFORE processing patterns
      fs.emptyDirSync(paths.public.patterns);
    }

    try {
      patternlab.data = buildPatternData(paths.source.data, fs);
    } catch (ex) {
      plutils.error('missing or malformed' + paths.source.data + 'data.json  Pattern Lab may not work without this file.');
      patternlab.data = {};
    }
    try {
      patternlab.listitems = dataLoader.loadDataFromFile(path.resolve(paths.source.data, 'listitems'), fs);
    } catch (ex) {
      plutils.warning('WARNING: missing or malformed ' + paths.source.data + 'listitems file.  Pattern Lab may not work without this file.');
      patternlab.listitems = {};
    }
    try {
      patternlab.header = fs.readFileSync(path.resolve(paths.source.patternlabFiles['general-header']), 'utf8');
      patternlab.footer = fs.readFileSync(path.resolve(paths.source.patternlabFiles['general-footer']), 'utf8');
      patternlab.patternSection = fs.readFileSync(path.resolve(paths.source.patternlabFiles.patternSection), 'utf8');
      patternlab.patternSectionSubType = fs.readFileSync(path.resolve(paths.source.patternlabFiles.patternSectionSubtype), 'utf8');
      patternlab.viewAll = fs.readFileSync(path.resolve(paths.source.patternlabFiles.viewall), 'utf8');
    } catch (ex) {
      console.log(ex);
      plutils.error('\nERROR: missing an essential file from ' + paths.source.patternlabFiles + '. Pattern Lab won\'t work without this file.\n');
      process.exit(1);
    }
    patternlab.patterns = [];
    patternlab.subtypePatterns = {};
    patternlab.partials = {};
    patternlab.data.link = {};

    setCacheBust();

    pattern_assembler.combine_listItems(patternlab);

    patternlab.events.emit('patternlab-build-global-data-end', patternlab);

    // diveSync once to perform iterative populating of patternlab object
    return processAllPatternsIterative(paths.source.patterns, patternlab).then(() => {

      patternlab.events.emit('patternlab-pattern-iteration-end', patternlab);

      //now that all the main patterns are known, look for any links that might be within data and expand them
      //we need to do this before expanding patterns & partials into extendedTemplates, otherwise we could lose the data -> partial reference
      pattern_assembler.parse_data_links(patternlab);

      //diveSync again to recursively include partials, filling out the
      //extendedTemplate property of the patternlab.patterns elements
      // TODO we can reduce the time needed by only processing changed patterns and their partials
      processAllPatternsRecursive(paths.source.patterns, patternlab);

      //take the user defined head and foot and process any data and patterns that apply
      processHeadPattern();
      processFootPattern();

      //cascade any patternStates
      lineage_hunter.cascade_pattern_states(patternlab);

      //set pattern-specific header if necessary
      let head;
      if (patternlab.userHead) {
        head = patternlab.userHead;
      } else {
        head = patternlab.header;
      }

      //set the pattern-specific header by compiling the general-header with data, and then adding it to the meta header
      patternlab.data.patternLabHead = pattern_assembler.renderPattern(patternlab.header, {
        cacheBuster: patternlab.cacheBuster
      });

      // If deletePatternDir == true or graph needs to be updated
      // rebuild all patterns
      let patternsToBuild = null;

      // If deletePatternDir == true or graph needs to be updated
      // rebuild all patterns
      patternsToBuild = null;

      if (incrementalBuildsEnabled) {
        // When the graph was loaded from file, some patterns might have been moved/deleted between runs
        // so the graph data become out of sync
        patternlab.graph.sync().forEach(n => {
          plutils.log.info("[Deleted/Moved] " + n);
        });

        // TODO Find created or deleted files
        const now = new Date().getTime();
        pattern_assembler.mark_modified_patterns(now, patternlab);
        patternsToBuild = patternlab.graph.compileOrder();
      } else {
        // build all patterns, mark all to be rebuilt
        patternsToBuild = patternlab.patterns;
        for (const p of patternsToBuild) {
          p.compileState = CompileState.NEEDS_REBUILD;
        }
      }

      //render all patterns last, so lineageR works
      patternsToBuild.forEach(pattern => renderSinglePattern(pattern, head));

      // Saves the pattern graph when all files have been compiled
      PatternGraph.storeToFile(patternlab);
      if (patternlab.config.exportToGraphViz) {
        PatternGraph.exportToDot(patternlab, "dependencyGraph.dot");
        plutils.log.info(`Exported pattern graph to ${path.join(config.paths.public.root, "dependencyGraph.dot")}`);
      }

      //export patterns if necessary
      pattern_exporter.export_patterns(patternlab);
    }).catch((err) => {
      console.log('Error in buildPatterns():', err);
    });
  }

  return {
    /**
     * logs current version
     *
     * @returns {void} current patternlab-node version as defined in package.json, as console output
     */
    version: function () {
      return logVersion();
    },

    /**
     * return current version
     *
     * @returns {string} current patternlab-node version as defined in package.json, as string
     */
    v: function () {
      return getVersion();
    },

    /**
     * build patterns, copy assets, and construct ui
     *
     * @param {function} callback a function invoked when build is complete
     * @param {object} options an object used to control build behavior
     * @returns {Promise} a promise fulfilled when build is complete
     */
    build: function (callback, options) {
      if (patternlab && patternlab.isBusy) {
        console.log('Pattern Lab is busy building a previous run - returning early.');
        return Promise.resolve();
      }
      patternlab.isBusy = true;
      return buildPatterns(options.cleanPublic).then(() => {

        new ui_builder().buildFrontend(patternlab);
        assetCopier().copyAssets(patternlab.config.paths, patternlab, options);

        this.events.on('patternlab-pattern-change', () => {
          if (!patternlab.isBusy) {
            options.cleanPublic = false;
            return this.build(callback, options);
          }
          return Promise.resolve();
        });

        this.events.on('patternlab-global-change', () => {
          if (!patternlab.isBusy) {
            options.cleanPublic = true; //rebuild everything
            return this.build(callback, options);
          }
          return Promise.resolve();
        });

        printDebug();
        patternlab.isBusy = false;
        callback();
      });
    },

    /**
     * logs usage
     *
     * @returns {void} pattern lab API usage, as console output
     */
    help: function () {
      help();
    },

    /**
     * build patterns only, leaving existing public files intact
     *
     * @param {function} callback a function invoked when build is complete
     * @param {object} options an object used to control build behavior
     * @returns {Promise} a promise fulfilled when build is complete
     */
    patternsonly: function (callback, options) {
      if (patternlab && patternlab.isBusy) {
        console.log('Pattern Lab is busy building a previous run - returning early.');
        return Promise.resolve();
      }
      patternlab.isBusy = true;
      return buildPatterns(options.cleanPublic).then(() => {
        printDebug();
        patternlab.isBusy = false;
        callback();
      });
    },

  /**
   * fetches starterkit repos from pattern-lab github org that contain 'starterkit' in their name
   *
   * @returns {Promise} Returns an Array<{name,url}> for the starterkit repos
   */
    liststarterkits: function () {
      return listStarterkits();
    },

    /**
     * load starterkit already available via `node_modules/`
     *
     * @param {string} starterkitName name of starterkit
     * @param {boolean} clean whether or not to delete contents of source/ before load
     * @returns {void}
     */
    loadstarterkit: function (starterkitName, clean) {
      loadStarterKit(starterkitName, clean);
    },


    /**
     * install plugin already available via `node_modules/`
     *
     * @param {string} pluginName name of plugin
     * @returns {void}
     */
    installplugin: function (pluginName) {
      installPlugin(pluginName);
    },

    /**
     * returns all file extensions supported by installed PatternEngines
     *
     * @returns {Array<string>} all supported file extensions
     */
    getSupportedTemplateExtensions: function () {
      return getSupportedTemplateExtensions();
    },

    /**
     * build patterns, copy assets, and construct ui, watch source files, and serve locally
     *
     * @param {object} options an object used to control build, copy, and serve behavior
     * @returns {Promise} TODO: validate
     */
    serve: function (options) {
      options.watch = true;
      return this.build(() => {}, options).then(function () {
        serve(patternlab);
      });
    },
    events: patternlab.events
  };
};

// export these free functions so they're available without calling the exported
// function, for use in reducing code dupe in unit tests. At least, until we
// have a better way to do this
patternlab_engine.build_pattern_data = buildPatternData;
patternlab_engine.process_all_patterns_iterative = processAllPatternsIterative;
patternlab_engine.process_all_patterns_recursive = processAllPatternsRecursive;

module.exports = patternlab_engine;
