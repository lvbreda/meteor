var path = require('path');
var os = require('os');
var _ = require('underscore');
var files = require('./files.js');
var watch = require('./watch.js');
var Builder = require('./builder.js');
var project = require('./project.js');
var meteorNpm = require('./meteor_npm.js');
var archinfo = require(path.join(__dirname, 'archinfo.js'));
var linker = require(path.join(__dirname, 'linker.js'));
var fs = require('fs');

// Find all files under `rootPath` that have an extension in
// `extensions` (an array of extensions without leading dot), and
// return them as a list of paths relative to sourceRoot. Ignore files
// that match a regexp in the ignoreFiles array, if given. As a
// special case (ugh), push all html files to the head of the list.
var scanForSources = function (rootPath, extensions, ignoreFiles) {
  var self = this;

  // find everything in tree, sorted depth-first alphabetically.
  var fileList = files.file_list_sync(rootPath, extensions);
  fileList = _.reject(fileList, function (file) {
    return _.any(ignoreFiles || [], function (pattern) {
      return file.match(pattern);
    });
  });
  fileList.sort(files.sort);

  // XXX HUGE HACK --
  // push html (template) files ahead of everything else. this is
  // important because the user wants to be able to say
  // Template.foo.events = { ... }
  //
  // maybe all of the templates should go in one file? packages
  // should probably have a way to request this treatment (load
  // order dependency tags?) .. who knows.
  var htmls = [];
  _.each(fileList, function (filename) {
    if (path.extname(filename) === '.html') {
      htmls.push(filename);
      fileList = _.reject(fileList, function (f) { return f === filename;});
    }
  });
  fileList = htmls.concat(fileList);

  // now make everything relative to rootPath
  var prefix = rootPath;
  if (prefix[prefix.length - 1] !== path.sep)
    prefix += path.sep;

  return fileList.map(function (abs) {
    if (path.relative(prefix, abs).match(/\.\./))
      // XXX audit to make sure it works in all possible symlink
      // scenarios
      throw new Error("internal error: source file outside of parent?");
    return abs.substr(prefix.length);
  });
};

///////////////////////////////////////////////////////////////////////////////
// Slice
///////////////////////////////////////////////////////////////////////////////

// Options:
// - name [required]
// - arch [required]
// - uses
// - sources
// - forceExport
// - dependencyInfo
// - nodeModulesPath
//
// Do not include the source files in dependencyInfo. They will be
// added at compile time when the sources are actually read.
var Slice = function (pkg, options) {
  var self = this;
  options = options || {};
  self.pkg = pkg;

  // Name for this slice. For example, the "client" in "ddp.client"
  // (which, NB, we might load on server arches.)
  self.sliceName = options.name;

  // The architecture (fully or partially qualified) that can use this
  // slice.
  self.arch = options.arch;

  // Unique ID for this slice. Unique across all slices of all
  // packages, but constant across reloads of this slice.
  self.id = pkg.id + "." + options.name + "@" + self.arch;

  // Packages used. The ordering is significant only for determining
  // import symbol priority (it doesn't affect load order), and a
  // given package could appear more than once in the list, so code
  // that consumes this value will need to guard appropriately. Each
  // element in the array has keys:
  // - spec: either 'packagename' or 'packagename.slicename'
  // - unordered: If true, we don't want the package's imports and we
  //   don't want to force the package to load before us. We just want
  //   to ensure that it loads if we load.
  self.uses = options.uses;

  // This slice's source files. Array of paths. Empty if loaded from
  // unipackage.
  self.sources = options.sources || [];

  // Symbols that this slice should export even if @export directives
  // don't appear in the source code. List of symbols (as strings.)
  // Empty if loaded from unipackage.
  self.forceExport = options.forceExport || [];

  // Files and directories that we want to monitor for changes in
  // development mode, such as source files and package.js, in the
  // format accepted by watch.Watcher.
  self.dependencyInfo = options.dependencyInfo ||
    { files: {}, directories: {} };

  // Has this slice been compiled?
  self.isCompiled = false;

  // All symbols exported from the JavaScript code in this
  // package. Array of string symbol (eg "Foo", "Bar.baz".) Set only
  // after _ensureCompiled().
  self.exports = null;

  // Prelink output. 'boundary' is a magic cookie used for inserting
  // imports. 'prelinkFiles' is the partially linked JavaScript code
  // (an array of objects with keys 'source' and 'servePath', both
  // strings -- see prelink() in linker.js) Both of these are inputs
  // into the final link phase, which inserts the final JavaScript
  // resources into 'resources'. Set only after _ensureCompiled().
  self.boundary = null;
  self.prelinkFiles = null;

  // All of the data provided for eventual inclusion in the bundle,
  // other than JavaScript that still needs to be fed through the
  // final link stage. A list of objects with these keys:
  //
  // type: "js", "css", "head", "body", "static"
  //
  // data: The contents of this resource, as a Buffer. For example,
  // for "head", the data to insert in <head>; for "js", the
  // JavaScript source code (which may be subject to further
  // processing such as minification); for "static", the contents of a
  // static resource such as an image.
  //
  // servePath: The (absolute) path at which the resource would prefer
  // to be served. Interpretation varies by type. For example, always
  // honored for "static", ignored for "head" and "body", sometimes
  // honored for CSS but ignored if we are concatenating.
  //
  // Set only after _ensureCompiled().
  self.resources = null;

  // Absolute path to the node_modules directory to use at runtime to
  // resolve Npm.require() calls in this slice. null if this slice
  // does not have a node_modules.
  self.nodeModulesPath = options.nodeModulesPath;
};

_.extend(Slice.prototype, {
  // Add more source files. 'sources' is an array of paths. Cannot be
  // called after _ensureCompiled().
  addSources: function (sources) {
    var self = this;
    if (self.isCompiled)
      throw new Error("Too late to add sources");
    self.sources = self.sources.concat(sources);
  },

  // Process all source files through the appropriate handlers and run
  // the prelink phase on any resulting JavaScript. Also add all
  // provided source files to the package dependencies. Sets fields
  // such as dependencies, exports, boundary, prelinkFiles, and
  // resources. Idempotent.
  _ensureCompiled: function () {
    var self = this;
    var isApp = ! self.pkg.name;

    if (self.isCompiled)
      return;

    var resources = [];
    var js = [];

    _.each(self.sources, function (relPath) {
      var absPath = path.resolve(self.pkg.sourceRoot, relPath);
      var ext = path.extname(relPath).substr(1);
      var handler = self._getSourceHandler(ext);
      var contents = fs.readFileSync(absPath);
      self.dependencyInfo.files[absPath] = Builder.sha1(contents);

      if (! handler) {
        // If we don't have an extension handler, serve this file as a
        // static resource on the client, or ignore it on the server.
        //
        // XXX This is pretty confusing, especially if you've
        // accidentally forgotten a plugin -- revisit?
        if (archinfo.matches(self.arch, "browser")) {
          resources.push({
            type: "static",
            data: contents,
            servePath: path.join(self.pkg.serveRoot, relPath)
          });
        }
        return;
      }

      // This object is called a #CompileStep and it's the interface
      // to plugins that define new source file handlers (eg,
      // Coffeescript.)
      //
      // Fields on CompileStep:
      //
      // - arch: the architecture for which we are building
      // - inputSize: total number of bytes in the input file
      // - inputPath: the filename and (relative) path of the input
      //   file, eg, "foo.js". We don't provide a way to get the full
      //   path because you're not supposed to read the file directly
      //   off of disk. Instead you should call read(). That way we
      //   can ensure that the version of the file that you use is
      //   exactly the one that is recorded in the dependency
      //   information.
      // - rootOutputPath: on browser targets, for resources such as
      //   stylesheet and static assets, this is the root URL that
      //   will get prepended to the paths you pick for your output
      //   files so that you get your own namespace, for example
      //   '/packages/foo'.
      // - read(n): read from the input file. If n is given it should
      //   be an integer, and you will receive the next n bytes of the
      //   file as a Buffer. If n is omitted you get the rest of the
      //   file.
      // - appendDocument({ section: "head", data: "my markup" })
      //   Browser targets only. Add markup to the "head" or "body"
      //   section of the document.
      // - addStylesheet({ path: "my/stylesheet.css", data: "my css" })
      //   Browser targets only. Add a stylesheet to the
      //   document. 'path' is a requested URL for the stylesheet that
      //   may or may not ultimately be honored. (Meteor will add
      //   appropriate tags to cause the stylesheet to be loaded. It
      //   will be subject to any stylesheet processing stages in
      //   effect, such as minification.)
      // - addJavaScript({ path: "my/program.js", data: "my code" })
      //   Add JavaScript code, which will be namespaced into this
      //   package's environment (eg, it will see only the exports of
      //   this package's imports), and which will be subject to
      //   minification and so forth. Again, 'path' is merely a hint
      //   that may or may not be honored.
      // - addAsset({ path: "my/image.png", data: Buffer })
      //   Browser targets only. Add a file to serve as-is over HTTP.
      //   This time `data` is a Buffer rather than a string. It will
      //   be served at the exact path you request (concatenated with
      //   rootOutputPath.)
      //
      // XXX for now, these handlers must only generate portable code
      // (code that isn't dependent on the arch, other than 'browser'
      // vs 'native') -- they can look at the arch that is provided
      // but they can't rely on the running on that particular arch
      // (in the end, an arch-specific slice will be emitted only if
      // there are native node modules.) Obviously this should
      // change. A first step would be a setOutputArch() function
      // analogous to what we do with native node modules, but maybe
      // what we want is the ability to ask the plugin ahead of time
      // how specific it would like to force builds to be.
      //
      // XXX we handle encodings in a rather cavalier way and I
      // suspect we effectively end up assuming utf8. We can do better
      // than that!
      //
      // XXX addAsset probably wants to be able to set MIME type and
      // also control any manifest field we deem relevant (if any)
      //
      // XXX Some handlers process languages that have the concept of
      // include files. These are problematic because we need to
      // somehow instrument them to get the names and hashs of all of
      // the files that they read for dependency tracking purposes. We
      // don't have an API for that yet, so for now we provide a
      // workaround, which is that _fullInputPath contains the full
      // absolute path to the input files, which allows such a plugin
      // to set up its include search path. It's then on its own for
      // registering dependencies (for now..)
      var readOffset = 0;
      var compileStep = {
        inputSize: contents.length,
        inputPath: relPath,
        _fullInputPath: absPath, // avoid, see above..
        rootOutputPath: self.pkg.serveRoot,
        arch: self.arch,
        read: function (n) {
          if (n === undefined || readOffset + n > contents.length)
            n = contents.length - readOffset;
          var ret = contents.slice(readOffset, readOffset + n);
          readOffset += n;
          return ret;
        },
        appendDocument: function (options) {
          if (! archinfo.matches(self.arch, "browser"))
            throw new Error("Document sections can only be emitted to " +
                            "browser targets");
          if (options.section !== "head" && options.section !== "body")
            throw new Error("'section' must be 'head' or 'body'");
          resources.push({
            type: options.section,
            data: new Buffer(options.data, 'utf8')
          });
        },
        addStylesheet: function (options) {
          if (! archinfo.matches(self.arch, "browser"))
            throw new Error("Stylesheets can only be emitted to " +
                            "browser targets");
          resources.push({
            type: "css",
            data: new Buffer(options.data, 'utf8'),
            servePath: options.path
          });
        },
        addJavaScript: function (options) {
          js.push({
            source: options.data,
            servePath: options.path
          });
        },
        addAsset: function (options) {
          if (! archinfo.matches(self.arch, "browser"))
            throw new Error("Sorry, currently, static assets can only be " +
                            "emitted to browser targets");
          resources.push({
            type: "static",
            data: options.data,
            servePath: options.path
          });
        }
      };

      handler(compileStep);
    });

    // Phase 1 link
    var results = linker.prelink({
      inputFiles: js,
      useGlobalNamespace: isApp,
      combinedServePath: isApp ? null :
        "/packages/" + self.pkg.name +
        (self.sliceName === "main" ? "" : ("." + self.sliceName)) + ".js",
      // XXX report an error if there is a package called global-imports
      importStubServePath: '/packages/global-imports.js',
      name: self.pkg.name || null,
      forceExport: self.forceExport
    });

    self.prelinkFiles = results.files;
    self.boundary = results.boundary;
    self.exports = results.exports;
    self.resources = resources;
    self.isCompiled = true;
  },

  // Get the resources that this function contributes to a bundle, in
  // the same format as self.resources as documented above. This
  // includes static assets and fully linked JavaScript.
  //
  // @param bundleArch The architecture targeted by the bundle. Might
  // be more specific than self.arch.
  //
  // It is when you call this function that we read our dependent
  // packages and commit to whatever versions of them we currently
  // have in the library -- at least for the purpose of imports, which
  // is resolved at bundle time. (On the other hand, when it comes to
  // the extension handlers we'll use, we previously commited to those
  // versions at package build ('compile') time.)
  getResources: function (bundleArch) {
    var self = this;
    var library = self.pkg.library;
    self._ensureCompiled();

    if (! archinfo.matches(bundleArch, self.arch))
      throw new Error("slice of arch '" + self.arch + "' does not support '" +
                      bundleArch + "'?");

    // Compute imports by merging the exports of all of the packages
    // we use. Note that in the case of conflicting symbols, later
    // packages get precedence.
    var imports = {}; // map from symbol to supplying package name
    _.each(_.values(self.uses), function (u) {
      if (! u.unordered) {
        _.each(library.getSlices(u.spec, bundleArch), function (otherSlice) {
          otherSlice._ensureCompiled(); // make sure otherSlice.exports is valid
          _.each(otherSlice.exports, function (symbol) {
            imports[symbol] = otherSlice.pkg.name;
          });
        });
      }
    });

    // Phase 2 link
    var isApp = ! self.pkg.name;
    var files = linker.link({
      imports: imports,
      useGlobalNamespace: isApp,
      prelinkFiles: self.prelinkFiles,
      boundary: self.boundary
    });

    // Add each output as a resource
    var jsResources = _.map(files, function (file) {
      return {
        type: "js",
        data: new Buffer(file.source, 'utf8'),
        servePath: file.servePath
      };
    });

    return _.union(self.resources, jsResources); // union preserves order
  },

  // Get all extensions handlers registered in this slice, as a map
  // from extension (no leading dot) to handler function. Throws an
  // exception if two packages are registered for the same extension.
  _allHandlers: function () {
    var self = this;
    var ret = {};

    // XXX we used to include our own extensions only if we were the
    // "use" role. now we include them everywhere because we don't
    // have a special "use" role anymore. it's not totally clear to me
    // what the correct behavior should be -- we need to resolve
    // whether we think about extensions as being global to a package
    // or particular to a slice.
    self.pkg._ensurePluginsInitialized();
    _.extend(ret, self.pkg.sourceHandlers);
    _.extend(ret, self.pkg.legacyExtensionHandlers);

    _.each(self.uses, function (u) {
      var otherPkg = self.pkg.library.get(u.spec.split('.')[0]);
      otherPkg._ensurePluginsInitialized();
      var all = _.extend({}, otherPkg.sourceHandlers);
      _.extend(all, otherPkg.legacyExtensionHandlers);

      _.each(all, function (handler, ext) {
        if (ext in ret && ret[ext] !== handler)
          // XXX do something more graceful than printing a stack
          // trace and exiting!! we have higher standards than that!
          throw new Error("Conflict: two packages included in " +
                          (self.pkg.name || "your app") + ", " +
                          (ret[ext].pkg.name || "your app") + " and " +
                          (otherPkg.name || "your app") + ", " +
                          "are both trying to handle ." + ext);
        ret[ext] = handler;
      });
    });

    return ret;
  },

  // Return a list of all of the extension that indicate source files
  // for this slice, not including leading dots. Computed based on
  // this.uses, so should only be called once that has been set.
  registeredExtensions: function () {
    var self = this;
    return _.keys(self._allHandlers());
  },

  // Find the function that should be used to handle a source file for
  // this slice, or return null if there isn't one. We'll use handlers
  // that are defined in this package and in its immediate
  // dependencies. ('extension' should be the extension of the file
  // without a leading dot.)
  _getSourceHandler: function (extension) {
    var self = this;
    return (self._allHandlers())[extension] || null;
  }
});

///////////////////////////////////////////////////////////////////////////////
// Packages
///////////////////////////////////////////////////////////////////////////////

var nextPackageId = 1;
var Package = function (library) {
  var self = this;

  // A unique ID (guaranteed to not be reused in this process -- if
  // the package is reloaded, it will get a different id the second
  // time)
  self.id = nextPackageId++;

  // The name of the package, or null for an app pseudo-package or
  // collection. The package's exports will reside in Package.<name>.
  // When it is null it is linked like an application instead of like
  // a package.
  self.name = null;

  // The path from which this package was loaded. null if loaded from
  // unipackage.
  self.sourceRoot = null;

  // XXX needs docs
  // null if loaded from unipackage
  self.serveRoot = null;

  // Package library that should be used to resolve this package's
  // dependencies
  self.library = library;

  // Package metadata. Keys are 'summary' and 'internal'.
  self.metadata = {};

  // File handler extensions defined by this package. Map from file
  // extension to the handler function.
  self.legacyExtensionHandlers = {};

  // Available editions/subpackages ("slices") of this package. Array
  // of Slice.
  self.slices = [];

  // Map from an arch to the list of slice names that should be
  // included by default if this package is used without specifying a
  // slice (eg, as "ddp" rather than "ddp.server"). The most specific
  // arch will be used.
  self.defaultSlices = {};

  // Map from an arch to the list of slice names that should be
  // included when this package is tested. The most specific arch will
  // be used.
  self.testSlices = {};

  // Plugins in this package. Map from plugin name to bundler.Plugin.
  self.plugins = {};

  // True if plugins have been initialized (if
  // _ensurePluginsInitialized has been called)
  self._pluginsInitialized = false;

  // Source file handlers registered by plugins. Map from extension
  // (without a dot) to a handler function that takes a
  // CompileStep. Valid only when _pluginsInitialized is true.
  self.sourceHandlers = null;
};

_.extend(Package.prototype, {
  // Return the slice of the package to use for a given slice name
  // (eg, 'main' or 'test') and target architecture (eg,
  // 'native.linux.x86_64' or 'browser'), or throw an exception if
  // that packages can't be loaded under these circumstances.
  getSingleSlice: function (name, arch) {
    var self = this;

    var chosenArch = archinfo.mostSpecificMatch(
      arch, _.pluck(_.where(self.slices, { sliceName: name }), 'arch'));

    if (! chosenArch) {
      // XXX need improvement. The user should get a graceful error
      // message, not an exception, and all of this talk of slices an
      // architectures is likely to be confusing/overkill in many
      // contexts.
      throw new Error((self.name || "This app") +
                      " does not have a slice named '" + name +
                      "' that runs on architecture '" + arch + "'");
    }

    return _.where(self.slices, { sliceName: name, arch: chosenArch })[0];
  },

  // Return the slices that should be used on a given arch if the
  // package is named without any qualifiers (eg, 'ddp' rather than
  // 'ddp.client').
  getDefaultSlices: function (arch) {
    var self = this;

    var chosenArch = archinfo.mostSpecificMatch(arch,
                                                _.keys(self.defaultSlices));
    if (! chosenArch)
      throw new Error((self.name || "This app") +
                      " is not compatible with architecture '" + arch + "'");

    return _.map(self.defaultSlices[chosenArch], function (name) {
      return self.getSingleSlice(name, arch);
    });
  },

  // Return the slices that should be used to test the package on a
  // given arch.
  getTestSlices: function (arch) {
    var self = this;

    var chosenArch = archinfo.mostSpecificMatch(arch,
                                                _.keys(self.testSlices));
    if (! chosenArch)
      throw new Error((self.name || "This app") +
                      " does not have tests for architecture " + arch + "'");

    return _.map(self.testSlices[chosenArch], function (name) {
      return self.getSingleSlice(name, arch);
    });
  },

  // This is called on all packages at Meteor install time so they can
  // do any prep work necessary for the user's first Meteor run to be
  // fast, for example fetching npm dependencies. Currently thanks to
  // refactorings there's nothing to do here.
  // XXX remove?
  preheat: function () {
  },

  // If this package has plugins, initialize them (run the startup
  // code in them so that they register their extensions.) Idempotent.
  _ensurePluginsInitialized: function () {
    var self = this;
    if (self._pluginsInitialized)
      return;

    var Plugin = {
      // 'extension' is a file extension without a dot (eg 'js', 'coffee')
      //
      // 'handler' is a function that takes a single argument, a
      // CompileStep (#CompileStep)
      registerSourceHandler: function (extension, handler) {
        if (extension in self.sourceHandlers)
          throw new Error("Package " + self.name + " defines two " +
                          "source handlers for the same extension ('." +
                          extension + "')");
        self.sourceHandlers[extension] = handler;
      }
    };

    self.sourceHandlers = [];
    _.each(self.plugins, function (plugin) {
      plugin.load({Plugin: Plugin});
    });

    self._pluginsInitialized = true;
  },

  // Programmatically create a package from scratch. For now, cannot
  // create browser packages.
  //
  // Options:
  // - sliceName
  // - use
  // - sources
  // - npmDependencies
  // - npmDir
  initFromOptions: function (name, options) {
    var self = this;
    self.name = name;

    var isPortable = true;
    var nodeModulesPath = null;
    if (options.npmDependencies) {
      meteorNpm.ensureOnlyExactVersions(option.npmDependencies);
      meteorNpm.updateDependencies(name, options.npmDir,
                                   options.npmDependencies);
      if (! meteorNpm.dependenciesArePortable(options.npmDir))
        isPortable = false;
      nodeModulesPath = path.join(options.npmDir, 'node_modules');
    }

    var arch = isPortable ? "native" : archinfo.host();
    var slice = new Slice(self, {
      name: options.sliceName,
      arch: arch,
      uses: _.map(["meteor"].concat(options.use || []), function (spec) {
        return { spec: spec }
      }),
      sources: options.sources || [],
      nodeModulesPath: nodeModulesPath
    });
    self.slices.push(slice);

    self.defaultSlices = {'native': [options.sliceName]};
  },

  // loads a package's package.js file into memory, using
  // runInThisContext. Wraps the contents of package.js in a closure,
  // supplying pseudo-globals 'Package' and 'Npm'.
  //
  // options:
  // - skipNpmUpdate: if true, don't refresh .npm/node_modules (for
  //   packages that use Npm.depend). Only use this when you are
  //   certain that .npm/node_modules was previously created by some
  //   other means, and you're certain that the package's Npm.depend
  //   instructions haven't changed since then.
  initFromPackageDir: function (name, dir, options) {
    var self = this;
    var isPortable = true;
    options = options || {};
    self.name = name;
    self.sourceRoot = dir;
    self.serveRoot = path.join(path.sep, 'packages', name);

    if (!fs.existsSync(self.sourceRoot))
      throw new Error("The package named " + self.name + " does not exist.");

    var roleHandlers = {use: null, test: null};
    var npmDependencies = null;

    // Plugins defined by this package. Array of object each with the
    // same keys as the options to _transitional_registerBuildPlugin.
    var plugins = [];

    var packageJsPath = path.join(self.sourceRoot, 'package.js');
    var code = fs.readFileSync(packageJsPath);
    var packageJsHash = Builder.sha1(code);
    // \n is necessary in case final line is a //-comment
    var wrapped = "(function(Package,Npm){" + code.toString() + "\n})";
    // See #runInThisContext
    //
    // XXX it'd be nice to runInNewContext so that the package
    // setup code can't mess with our globals, but objects that
    // come out of runInNewContext have bizarro antimatter
    // prototype chains and break 'instanceof Array'. for now,
    // steer clear
    var func = require('vm').runInThisContext(wrapped, packageJsPath, true);
    func({
      // == 'Package' object visible in package.js ==

      // Set package metadata. Options:
      // - summary: for 'meteor list'
      // - internal: if true, hide in list
      // There used to be a third option documented here,
      // 'environments', but it was never implemented and no package
      // ever used it.
      describe: function (options) {
        _.extend(self.metadata, options);
      },

      on_use: function (f) {
        if (roleHandlers.use)
          throw new Error("A package may have only one on_use handler");
        roleHandlers.use = f;
      },

      on_test: function (f) {
        if (roleHandlers.test)
          throw new Error("A package may have only one on_test handler");
        roleHandlers.test = f;
      },

      // extension doesn't contain a dot
      register_extension: function (extension, callback) {
        if (_.has(self.legacyExtensionHandlers, extension))
          throw new Error("This package has already registered a handler for " +
                          extension);
        self.legacyExtensionHandlers[extension] = function (compileStep) {

          // In the old extension API, there is a 'where' parameter
          // that conflates architecture and slice name and can be
          // either "client" or "server".
          var clientOrServer = archinfo.matches(compileStep.arch, "browser") ?
            "client" : "server";

          var api = {
            /**
             * In the legacy extension API, this is the ultimate low-level
             * entry point to add data to the bundle.
             *
             * type: "js", "css", "head", "body", "static"
             *
             * path: the (absolute) path at which the file will be
             * served. ignored in the case of "head" and "body".
             *
             * source_file: the absolute path to read the data from. if
             * path is set, will default based on that. overridden by
             * data.
             *
             * data: the data to send. overrides source_file if
             * present. you must still set path (except for "head" and
             * "body".)
             */
            add_resource: function (options) {
              var sourceFile = options.source_file || options.path;

              var data;
              if (options.data) {
                data = options.data;
                if (!(data instanceof Buffer)) {
                  if (!(typeof data === "string"))
                    throw new Error("Bad type for data");
                  data = new Buffer(data, 'utf8');
                }
              } else {
                if (!sourceFile)
                  throw new Error("Need either source_file or data");
                data = fs.readFileSync(sourceFile);
              }

              if (options.where && options.where !== clientOrServer)
                throw new Error("'where' is deprecated here and if provided " +
                                "must be '" + clientOrServer + "'");

              var relPath = path.relative(compileStep.rootOutputPath,
                                          options.path);


              if (options.type === "js")
                compileStep.addJavaScript({ path: relPath,
                                            data: data.toString('utf8') });
              else if (options.type === "head" || options.type === "body")
                compileStep.appendDocument({ section: options.type,
                                             data: data.toString('utf8') });
              else if (options.type === "css")
                compileStep.addStylesheet({ path: relPath,
                                            data: data.toString('utf8') });
              else if (options.type === "static")
                compileStep.addAsset({ path: relPath, data: data });
            },

            error: function (message) {
              // XXX this isn't very good. improve it (but in the new
              // API, not this legacy API)
              throw new Error("Error while running '" + name + "' plugin: " +
                              message);
            }
          };

          // old-school extension can only take the input as a file on
          // disk, so write it out to a temporary file for them. take
          // care to preserve the original extension since some legacy
          // plugins depend on that (coffeescript.) Also (sigh) put it
          // in the same directory as the original file so that
          // relative paths work for include files, for plugins that
          // care about that.
          var tmpdir = path.resolve(path.dirname(compileStep._fullInputPath));
          do {
            var tempFilePath =
              path.join(tmpdir, "build" +
                        Math.floor(Math.random() * 1000000) +
                        "." + path.basename(compileStep.inputPath));
          } while (fs.existsSync(tempFilePath));
          var tempFile = fs.openSync(tempFilePath, "wx");
          var data = compileStep.read();
          fs.writeSync(tempFile, data, 0, data.length);
          fs.closeSync(tempFile);

          try {
            callback(api, tempFilePath,
                     path.join(compileStep.rootOutputPath,
                               compileStep.inputPath),
                     clientOrServer);
          } finally {
            fs.unlinkSync(tempFilePath);
          }
        };
      },

      // Same as node's default `require` but is relative to the
      // package's directory. Regular `require` doesn't work well
      // because we read the package.js file and `runInThisContext` it
      // separately as a string.  This means that paths are relative
      // to the top-level meteor.js script rather than the location of
      // package.js
      _require: function(filename) {
        return require(path.join(self.sourceRoot, filename));
      },

      // Define a plugin. A plugin extends the build process for
      // targets that use this package. For example, a Coffeescript
      // compiler would be a plugin. A plugin is its own little
      // program, with its own set of source files, used packages, and
      // npm dependencies.
      //
      // This is an experimental API and for now you should assume
      // that it will change frequently and radically. For maximum R&D
      // velocity and for the good of the platform, we will push
      // changes that break your packages. You've been warned.
      //
      // Options:
      // - name: a name for this plugin. required (cosmetic -- string)
      // - use: package to use for the plugin (names, as strings)
      // - sources: sources for the plugin (array of string)
      // - npmDependencies: map from npm package name to required
      //   version (string)
      _transitional_registerBuildPlugin: function (options) {
        if (! (name in options))
          throw new Error("Bulid plugins require a name");
        // XXX further type checking
        plugins.push(options);
      }
    }, {
      // == 'Npm' object visible in package.js ==
      depends: function (_npmDependencies) {
        // XXX make npmDependencies be per slice, so that production
        // doesn't have to ship all of the npm modules used by test
        // code
        if (npmDependencies)
          throw new Error("Can only call `Npm.depends` once in package " +
                          self.name + ".");
        if (typeof npmDependencies !== 'object')
          throw new Error("The argument to Npm.depends should look like: " +
                          "{gcd: '0.0.0'}");
        npmDependencies = _npmDependencies;

        // don't allow npm fuzzy versions so that there is complete
        // consistency when deploying a meteor app
        //
        // XXX use something like seal or lockdown to have *complete*
        // confidence we're running the same code?
        meteorNpm.ensureOnlyExactVersions(npmDependencies);
      },

      require: function (name) {
        var nodeModuleDir = path.join(self.sourceRoot,
                                      '.npm', 'node_modules', name);
        if (fs.existsSync(nodeModuleDir)) {
          return require(nodeModuleDir);
        } else {
          try {
            return require(name); // from the dev bundle
          } catch (e) {
            throw new Error("Can't find npm module '" + name +
                            "'. Did you forget to call 'Npm.depends'?");
          }
        }
      }
    });

    // source files used
    var sources = {use: {client: [], server: []},
                   test: {client: [], server: []}};

    // symbols force-exported
    var forceExport = {use: {client: [], server: []},
                       test: {client: [], server: []}};

    // packages used (keys are 'name' and 'unordered')
    var uses = {use: {client: [], server: []},
                test: {client: [], server: []}};

    // For this old-style, on_use/on_test/where-based package, figure
    // out its dependencies by calling its on_xxx functions and seeing
    // what it does.
    //
    // We have a simple strategy. Call its on_xxx handler with no
    // 'where', which is what happens when the package is added
    // directly to an app, and see what files it adds to the client
    // and the server. Call the former the client version of the
    // package, and the latter the server version. Then, when a
    // package is used, include it in both the client and the server
    // by default. This simple strategy doesn't capture even 10% of
    // the complexity possible with on_use, on_test, and where, but
    // probably is sufficient for virtually all packages that actually
    // exist in the field, if not every single
    // one. #OldStylePackageSupport
    _.each(["use", "test"], function (role) {
      if (roleHandlers[role]) {
        roleHandlers[role]({
          // Called when this package wants to make another package be
          // used. Can also take literal package objects, if you have
          // anonymous packages you want to use (eg, app packages)
          //
          // options can include:
          //
          // - role: defaults to "use", but you could pass something
          //   like "test" if for some reason you wanted to include a
          //   package's tests
          //
          // - unordered: if true, don't require this package to load
          //   before us -- just require it to be loaded anytime. Also
          //   don't bring this package's imports into our
          //   namespace. If false, override a true value specified in
          //   a previous call to use for this package name. (A
          //   limitation of the current implementation is that this
          //   flag is not tracked per-environment or per-role.)  This
          //   option can be used to resolve circular dependencies in
          //   exceptional circumstances, eg, the 'meteor' package
          //   depends on 'handlebars', but all packages (including
          //   'handlebars') have an implicit dependency on
          //   'meteor'. Internal use only -- future support of this
          //   is not guaranteed. #UnorderedPackageReferences
          use: function (names, where, options) {
            options = options || {};

            if (!(names instanceof Array))
              names = names ? [names] : [];

            if (!(where instanceof Array))
              where = where ? [where] : ["client", "server"];

            _.each(names, function (name) {
              _.each(where, function (w) {
                if (options.role && options.role !== "use")
                  throw new Error("Role override is no longer supported");
                uses[role][w].push({
                  spec: name,
                  unordered: options.unordered || false
                });
              });
            });
          },

          // Top-level call to add a source file to a package. It will
          // be processed according to its extension (eg, *.coffee
          // files will be compiled to JavaScript.)
          add_files: function (paths, where) {
            if (!(paths instanceof Array))
              paths = paths ? [paths] : [];

            if (!(where instanceof Array))
              where = where ? [where] : [];

            _.each(paths, function (path) {
              _.each(where, function (w) {
                sources[role][w].push(path);
              });
            });
          },

          // Force the export of a symbol from this package. An
          // alternative to using @export directives. Possibly helpful
          // when you don't want to modify the source code of a third
          // party library.
          //
          // @param symbols String (eg "Foo", "Foo.bar") or array of String
          // @param where 'client', 'server', or an array of those
          exportSymbol: function (symbols, where) {
            if (!(symbols instanceof Array))
              symbols = symbols ? [symbols] : [];

            if (!(where instanceof Array))
              where = where ? [where] : [];

            _.each(symbols, function (symbol) {
              _.each(where, function (w) {
                forceExport[role][w].push(symbol);
              });
            });
          },
          error: function () {
            throw new Error("api.error(), ironically, is no longer supported");
          },
          registered_extensions: function () {
            throw new Error(
              "api.registered_extensions() is no longer supported");
          }
        });
      }
    });

    // Grab any npm dependencies. Keep them in a cache in the package
    // source directory so we don't have to do this from scratch on
    // every build.
    var nodeModulesPath = null;
    if (npmDependencies) {
      var packageNpmDir =
        path.resolve(path.join(self.sourceRoot, '.npm'));

      if (! options.skipNpmUpdate) {
        // go through a specialized npm dependencies update process,
        // ensuring we don't get new versions of any
        // (sub)dependencies. this process also runs mostly safely
        // multiple times in parallel (which could happen if you have
        // two apps running locally using the same package)
        meteorNpm.updateDependencies(name, packageNpmDir, npmDependencies);
      }

      nodeModulesPath = path.join(packageNpmDir, 'node_modules');
      if (! meteorNpm.dependenciesArePortable(packageNpmDir))
        isPortable = false;
    }

    // Create slices
    var nativeArch = isPortable ? "native" : archinfo.host();
    _.each(["use", "test"], function (role) {
      _.each(["browser", nativeArch], function (arch) {
        var where = (arch === "browser") ? "client" : "server";

        // Everything depends on the package 'meteor', which sets up
        // the basic environment) (except 'meteor' itself).
        if (! (name === "meteor" && role === "use")) {
          // Don't add the dependency if one already exists. This
          // allows the package to create an unordered dependency and
          // override the one that we'd add here. This is necessary to
          // resolve the circular dependency between meteor and
          // underscore (underscore depends weakly on meteor; it just
          // needs the .js extension handler.)
          var alreadyDependsOnMeteor =
            !! _.find(uses[role][where], function (u) {
              return u.spec === "meteor";
            });
          if (! alreadyDependsOnMeteor)
            uses[role][where].unshift({ spec: "meteor" });
        }

        // We need to create a separate (non ===) copy of
        // dependencyInfo for each slice.
        var dependencyInfo = { files: {}, directories: {} };
        dependencyInfo.files[packageJsPath] = packageJsHash;

        self.slices.push(new Slice(self, {
          name: ({ use: "main", test: "tests" })[role],
          arch: arch,
          uses: uses[role][where],
          sources: sources[role][where],
          forceExport: forceExport[role][where],
          dependencyInfo: dependencyInfo,
          nodeModulesPath: arch === nativeArch && nodeModulesPath || undefined
        }));
      });
    });

    // Default slices
    self.defaultSlices = { browser: ['main'], 'native': ['main'] };
    self.testSlices = { browser: ['tests'], 'native': ['tests'] };

    // Build plugins
    _.each(plugins, function (plugin) {
      if (plugin.name in self.plugins)
        throw new Error("Two plugins have the same name: '" +
                        plugin.name + "'");
      if (plugin.name.match(/\.\./) || plugin.name.match(/[\\\/]/))
        throw new Error("Bad plugin name");

      self.plugins[plugin.name] = bundler.buildPlugin({
        library: self.library,
        use: plugin.use,
        sources: plugin.sources,
        npmDependencies: plugin.npmDependencies,
        // Plugins have their own npm dependencies separate from the
        // rest of the package, so they need their own separate npm
        // shrinkwrap and cache state.
        npmDir: path.resolve(path.join(self.sourceRoot, '.npm', 'plugin',
                                       plugin.name))
      });
    });
  },

  initFromAppDir: function (appDir, ignoreFiles) {
    var self = this;
    appDir = path.resolve(appDir);
    self.name = null;
    self.sourceRoot = appDir;
    self.serveRoot = path.sep;

    _.each(["client", "server"], function (sliceName) {
      // Determine used packages
      var names = _.union(
          // standard client packages for the classic meteor stack.
          // XXX remove and make everyone explicitly declare all dependencies
          ['meteor', 'deps', 'session', 'livedata', 'mongo-livedata',
           'spark', 'templating', 'startup', 'past'],
        project.get_packages(appDir));

      var arch = sliceName === "server" ? "native" : "browser";

      // Create slice
      var slice = new Slice(self, {
        name: sliceName,
        arch: arch,
        uses: _.map(names, function (name) {
          return { spec: name }
        })
      });
      self.slices.push(slice);

      // Watch control files for changes
      // XXX this read has a race with the actual read that is used
      _.each([path.join(appDir, '.meteor', 'packages'),
              path.join(appDir, '.meteor', 'releases')], function (p) {
                if (fs.existsSync(p)) {
                  slice.dependencyInfo.files[p] =
                    Builder.sha1(fs.readFileSync(p));
                }
              });

      // Determine source files
      var allSources = scanForSources(
        self.sourceRoot, slice.registeredExtensions(),
        ignoreFiles || []);

      var withoutAppPackages = _.reject(allSources, function (sourcePath) {
        // Skip files that are in app packages. (Directories named "packages"
        // lower in the tree are OK.)
        return sourcePath.match(/^packages\//);
      });

      var otherSliceName = (sliceName === "server") ? "client" : "server";
      var withoutOtherSlice =
        _.reject(withoutAppPackages, function (sourcePath) {
          return (path.sep + sourcePath + path.sep).indexOf(
            path.sep + otherSliceName + path.sep) !== -1;
        });

      var tests = false; /* for now */
      var withoutOtherRole =
        _.reject(withoutOtherSlice, function (sourcePath) {
          var isTest =
            ((path.sep + sourcePath + path.sep).indexOf(
              path.sep + 'tests' + path.sep) !== -1);
          return isTest !== (!!tests);
        });

      slice.addSources(withoutOtherRole);

      // Directories to monitor for new files
      slice.dependencyInfo.directories[appDir] = {
        include: _.map(slice.registeredExtensions(), function (ext) {
          return new RegExp('\\.' + ext + "$");
        }),
        exclude: ignoreFiles
      };

      // Inside the packages directory, only look for new packages
      // (which we can detect by the appearance of a package.js file.)
      // Other than that, packages explicitly call out the files they
      // use.
      slice.dependencyInfo.directories[path.resolve(appDir, 'packages')] = {
        include: [ /^package\.js$/ ],
        exclude: ignoreFiles
      };

      // Exclude .meteor/local and everything under it.
      slice.dependencyInfo.directories[
        path.resolve(appDir, '.meteor', 'local')] = { exclude: [/.?/] };
    });

    self.defaultSlices = { browser: ['client'], 'native': ['server'] };
  },

  // options:
  // - onlyIfUpToDate: if true, then first check the unipackage's
  //   dependencies (if present) to see if it's up to date. If not,
  //   return false without loading the package. Otherwise return
  //   true. (If onlyIfUpToDate is not passed, always return true.)
  // - buildOfPath: If present, the source directory (as an absolute
  //   path on local disk) of which we think this unipackage is a
  //   build. If it's not (it was copied from somewhere else), we
  //   consider it not up to date (in the sense of onlyIfUpToDate) so
  //   that we can rebuild it and correct the absolute paths in the
  //   dependency information.
  initFromUnipackage: function (name, dir, options) {
    var self = this;
    options = options || {};

    var mainJson =
      JSON.parse(fs.readFileSync(path.join(dir, 'unipackage.json')));

    if (mainJson.version !== "1")
      throw new Error("Unsupported unipackage version: " +
                      JSON.stringify(mainJson.version));

    var buildInfoPath = path.join(dir, 'buildinfo.json');
    var buildInfoJson = fs.existsSync(buildInfoPath) ?
      JSON.parse(fs.readFileSync(buildInfoPath)) : {};

    // XXX should comprehensively sanitize (eg, typecheck) everything
    // read from json files

    // Read the dependency info (if present), and make the strings
    // back into regexps
    var dependencies = buildInfoJson.dependencies ||
      { files: {}, directories: {} };
    _.each(dependencies.directories, function (d) {
      _.each(["include", "exclude"], function (k) {
        d[k] = _.map(d[k], function (s) {
          return new RegExp(s);
        });
      });
    });

    // If we're supposed to check the dependencies, go ahead and do so
    if (options.onlyIfUpToDate) {
      if (options.buildOfPath &&
          (buildInfoJson.buildOfPath !== options.buildOfPath)) {
        // This catches the case where you copy a source tree that had
        // a .build directory and then modify a file. Without this
        // check you won't see a rebuild (even if you stop and restart
        // meteor), at least not until you modify the *original*
        // copies of the source files, because that is still where all
        // of the dependency info points.
        return false;
      }

      var isUpToDate = true;
      var watcher = new watch.Watcher({
        files: dependencies.files,
        directories: dependencies.directories,
        onChange: function () {
          isUpToDate = false;
        }
      });
      watcher.stop();

      if (! isUpToDate)
        return false;
    }

    self.name = name;
    self.metadata = {
      summary: mainJson.summary,
      internal: mainJson.internal
    };
    self.defaultSlices = mainJson.defaultSlices;
    self.testSlices = mainJson.testSlices;

    _.each(mainJson.slices, function (sliceMeta) {
      // aggressively sanitize path (don't let it escape to parent
      // directory)
      if (sliceMeta.path.match(/\.\./))
        throw new Error("bad path in unipackage");
      var sliceJson = JSON.parse(
        fs.readFileSync(path.join(dir, sliceMeta.path)));
      var sliceBasePath = path.dirname(path.join(dir, sliceMeta.path));

      if (sliceJson.version !== "1")
        throw new Error("Unsupported unipackage slice version: " +
                        JSON.stringify(sliceJson.version));

      var nodeModulesPath = null;
      if (sliceJson.node_modules) {
        if (sliceJson.node_modules.match(/\.\./))
          throw new Error("bad node_modules path in unipackage");
        nodeModulesPath = path.join(sliceBasePath, sliceJson.node_modules);
      }

      var slice = new Slice(self, {
        name: sliceMeta.name,
        arch: sliceMeta.arch,
        dependencyInfo: dependencies,
        nodeModulesPath: nodeModulesPath,
        uses: _.map(sliceJson.uses, function (u) {
          return {
            spec: u['package'] + (u.slice ? "." + u.slice : ""),
            unordered: u.unordered
          };
        })
      });

      slice.isCompiled = true;
      slice.exports = sliceJson.exports || [];
      slice.boundary = sliceJson.boundary;
      slice.prelinkFiles = [];
      slice.resources = [];

      _.each(sliceJson.resources, function (resource) {
        if (resource.file.match(/\.\./))
          throw new Error("bad resource file path in unipackage");

        var fd = fs.openSync(path.join(sliceBasePath, resource.file), "r");
        var data = new Buffer(resource.length);
        var count = fs.readSync(fd, data, 0, resource.length, resource.offset);
        if (count !== resource.length)
          throw new Error("couldn't read entire resource");

        if (resource.type === "prelink") {
          slice.prelinkFiles.push({
            source: data.toString('utf8'),
            servePath: resource.servePath
          });
        } else if (_.contains(["head", "body", "css", "js", "static"],
                              resource.type)) {
          slice.resources.push({
            type: resource.type,
            data: data,
            servePath: resource.servePath || undefined
          });
        } else
          throw new Error("bad resource type in unipackage: " +
                          JSON.stringify(resource.type));
      });

      self.slices.push(slice);
    });

    _.each(mainJson.plugins, function (pluginMeta) {
      if (pluginMeta.path.match(/\.\./))
        throw new Error("bad path in unipackage");
      var plugin = bundler.readPlugin(pluginMeta.path);
      // XXX would be nice to refactor so we don't have to manually
      // bash the arch in here
      plugin.arch = pluginMeta.arch;

      // XXX should refactor so that we can have plugins of multiple
      // different arches happily coexisting in memory, to match
      // slices. If this becomes a problem before we have a chance to
      // refactor, could just ignore plugins for arches that we don't
      // support, if we are careful to not then try to write out the
      // package and expect them to be intact..
      if (pluginMeta.name in self.plugins)
        throw new Error("Implementation limitation: this program " +
                        "cannot yet handle fat plugins, sorry");
      self.plugins[pluginMeta.name] = plugin;
    });

    return true;
  },

  // True if this package can be saved as a unipackage
  canBeSavedAsUnipackage: function () {
    var self = this;
    return _.keys(self.legacyExtensionHandlers || []).length === 0;
  },

  // options:
  //
  // - buildOfPath: Optional. The absolute path on local disk of the
  //   directory that was built to produce this package. Used as part
  //   of the dependency info to detect builds that were moved and
  //   then modified.
  saveAsUnipackage: function (outputPath, options) {
    var self = this;
    var builder = new Builder({ outputPath: outputPath });

    if (! self.canBeSavedAsUnipackage())
      throw new Error("This package can not yet be saved as a unipackage");

    try {

      var mainJson = {
        version: "1",
        summary: self.metadata.summary,
        internal: self.metadata.internal,
        slices: [],
        defaultSlices: self.defaultSlices,
        testSlices: self.testSlices,
        plugins: []
      };

      var buildInfoJson = {
        dependencies: { files: {}, directories: {} },
        source: options.buildOfPath || undefined,
      };

      builder.reserve("unipackage.json");
      builder.reserve("buildinfo.json");
      builder.reserve("node_modules", { directory: true });
      builder.reserve("head");
      builder.reserve("body");

      // Slices
      _.each(self.slices, function (slice) {
        slice._ensureCompiled();

        // Make up a filename for this slice
        var baseSliceName =
          (slice.sliceName === "main" ? "" : (slice.sliceName + ".")) +
          slice.arch;
        var sliceDir =
          builder.generateFilename(baseSliceName, { directory: true });
        var sliceJsonFile =
          builder.generateFilename(baseSliceName + ".json");

        mainJson.slices.push({
          name: slice.sliceName,
          arch: slice.arch,
          path: sliceJsonFile
        });

        // Merge slice dependencies
        // XXX is naive merge sufficient here?
        _.extend(buildInfoJson.dependencies.files,
                 slice.dependencyInfo.files);
        _.extend(buildInfoJson.dependencies.directories,
                 slice.dependencyInfo.directories);

        // Construct slice metadata
        var sliceJson = {
          version: "1",
          exports: slice.exports,
          uses: _.map(slice.uses, function (u) {
            var specParts = u.spec.split('.');
            if (specParts.length > 2)
              throw new Error("Bad package spec: " + u.spec);
            return {
              'package': specParts[0],
              slice: specParts[1] || undefined,
              unordered: u.unordered || undefined
            };
          }),
          node_modules: slice.nodeModulesPath ? 'node_modules' : undefined,
          resources: [],
          boundary: slice.boundary
        };

        // Output 'head', 'body' resources nicely
        var concat = {head: [], body: []};
        var offset = {head: 0, body: 0};
        _.each(slice.resources, function (resource) {
          if (_.contains(["head", "body"], resource.type)) {
            if (concat[resource.type].length) {
              concat[resource.type].push(new Buffer("\n", "utf8"));
              offset[resource.type]++;
            }
            if (! (resource.data instanceof Buffer))
              throw new Error("Resource data must be a Buffer");
            sliceJson.resources.push({
              type: resource.type,
              file: path.join(sliceDir, resource.type),
              length: resource.data.length,
              offset: offset[resource.type]
            });
            concat[resource.type].push(resource.data);
            offset[resource.type] += resource.data.length;
          }
        });
        _.each(concat, function (parts, type) {
          if (parts.length) {
            builder.write(path.join(sliceDir, type), {
              data: Buffer.concat(concat[type], offset[type])
            });
          }
        });

        // Output other resources each to their own file
        _.each(slice.resources, function (resource) {
          if (_.contains(["head", "body"], resource.type))
            return; // already did this one

          var resourcePath = builder.generateFilename(
            path.join(sliceDir, resource.servePath));

          builder.write(resourcePath, { data: resource.data });
          sliceJson.resources.push({
            type: resource.type,
            file: resourcePath,
            length: resource.data.length,
            offset: 0,
            servePath: resource.servePath || undefined
          });
        });

        // Output prelink resources
        _.each(slice.prelinkFiles, function (file) {
          var resourcePath = builder.generateFilename(
            path.join(sliceDir, file.servePath));
          var data = new Buffer(file.source, 'utf8');

          builder.write(resourcePath, {
            data: data
          });

          sliceJson.resources.push({
            type: 'prelink',
            file: resourcePath,
            length: data.length,
            offset: 0,
            servePath: file.servePath || undefined
          });
        });

        // If slice has included node_modules, copy them in
        if (slice.nodeModulesPath) {
          builder.copyDirectory({
            from: slice.nodeModulesPath,
            to: 'node_modules',
            depend: false
          });
        }

        // Control file for slice
        builder.writeJson(sliceJsonFile, sliceJson);
      });

      // Plugins
      _.each(self.plugins, function (plugin, name) {
        var pluginDir =
          builder.generateFilename('plugin.' + name + '.' + plugin.arch,
                                   { directory: true });
        plugin.write(builder.enter(pluginDir));
        mainJson.plugins.push({
          name: name,
          arch: plugin.arch,
          path: pluginDir
        });
      });

      // Prep dependencies for serialization by turning regexps into
      // strings
      _.each(buildInfoJson.dependencies.directories, function (d) {
        _.each(["include", "exclude"], function (k) {
          d[k] = _.map(d[k], function (r) {
            return r.sources;
          });
        });
      });

      builder.writeJson("unipackage.json", mainJson);
      builder.writeJson("buildinfo.json", buildInfoJson);
      builder.complete();
    } catch (e) {
      builder.abort();
      throw e;
    }
  }
});

var packages = exports;
_.extend(exports, {
  Package: Package
});
