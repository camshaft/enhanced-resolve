/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Tobias Koppers @sokra
*/
var path = require("path");
var parse = require("./parse");
var stringify = require("./stringify");
var matchRegExpObject = require("./matchRegExpObject");

// http://nodejs.org/docs/v0.4.8/api/all.html#all_Together...

function syncToAsync(fn) {
	return function(arg1, arg2, callback) {
		if(callback) {
			try {
				callback(null, fn(arg1, arg2));
			} catch(e) {
				callback(e);
			}
		} else {
			try {
				arg2(null, fn(arg1));
			} catch(e) {
				arg2(e);
			}
		}
	}
}

module.exports = function resolveFactory(config) {

var statAsync =		config.stat;
var statSync = 		syncToAsync(config.statSync);
var readFileAsync =	config.readFile;
var readFileSync =	syncToAsync(config.readFileSync);
var readdirAsync =	config.readdir;
var readdirSync =	syncToAsync(config.readdirSync);
var parsePackage =	config.parsePackage;


function resolve(context, resource, options, type, sync, callback) {
	function finalResult(err, absoluteFilename) {
		if(err) {
			callback(new Error("Module \"" + stringify({resource: resource}) + "\" not found in context \"" +
						context + "\"\n  " + err));
			return;
		}
		resource.path = absoluteFilename;
		callback(null, resource);
	}
	applyAlias(resource, options.alias);
	if(resource.module) {
		loadInModuleDirectories(context, resource.path, options, type, sync, finalResult);
	} else {
		var ending = resource.path.substr(-1);
		var pathname = resource.path[0] === "." ? join(split(context), split(resource.path)) : resource.path.replace(/[\\\/]$/, "");
		if(type === "context" || type === "loader-context") {
			(sync?statSync:statAsync)(pathname, function(err, stat) {
				if(err) {
					finalResult(err);
					return;
				}
				if(!stat.isDirectory()) {
					finalResult(new Error("Context \"" + pathname + "\" in not a directory"));
					return;
				}
				finalResult(null, pathname);
			});
		} else if(ending == "/" || ending == "\\") {
			loadAsDirectory(pathname, options, type, sync, finalResult);
		} else {
			loadAsFileOrDirectory(pathname, options, type, sync, finalResult);
		}
	}
}

function applyAlias(resource, alias) {
	var lastModuleName = null;
	while(resource.path && resource.module) {
		var moduleName = resource.path, remaining = "";
		var idx = moduleName.indexOf("/");
		if(idx >= 0) {
			remaining = moduleName.slice(idx);
			moduleName = moduleName.slice(0, idx);
		}
		if(!Object.prototype.hasOwnProperty.call(alias, moduleName)) return;
		if(typeof alias[moduleName] !== "string") return;
		if(lastModuleName == moduleName) return;
		lastModuleName = moduleName;
		resource.path = alias[moduleName] + remaining;
		resource.module = parse.isModule(resource.path);
	}
}

function doResolve(context, identifier, options, type, sync, callback) {
	var request;
	try {
		request = parse(identifier);
	} catch(e) { return callback(e); }
	var resource = request.resource;
	if(request.loaders && options.disableLoaders)
		return callback(new Error("Loaders are disabled"));
	if(request.loaders === null && resource === null) {
		// We want to resolve an empty identifier
		return onResolvedBoth();
	} else if(request.loaders !== null && request.loaders.length === 0 && resource === null) {
		// We want to resolve "!" or "!!" or ...
		return onResolvedBoth();
	} else if(request.loaders === null && resource && resource.path === null) {
		// We want to resolve something like "?query"
		return onResolvedBoth();
	} else if(request.loaders === null && type === "normal" && resource && resource.path !== null) {
		// We want to resolve something like "simple" or "./file"
		request.loaders = [];
		// We need the resource first to check if loaders apply.
		// We have to do it serial.
		resolve(context, resource, options, type, sync, function(err) {
			if(err) return callback(err);
			for(var i = 0; i < options.loaders.length; i++) {
				var line = options.loaders[i];
				if(matchRegExpObject(line, resource.path + (resource.query || ''))) {
					var loaders = parse(line.loader + "!").loaders;
					Array.prototype.push.apply(request.loaders, loaders);
					break;
				}
			}
			if(request.loaders.length == 0) return onResolvedBoth();

			resolveLoaders(context, request.loaders, options, sync, function(err) {
				if(err) return callback(err);
				onResolvedBoth();
			});
		});
	} else if(request.loaders === null) {
		resolve(context, resource, options, type, sync, function(err) {
			if(err) return callback(err);
			return onResolvedBoth();
		});
	} else if(resource === null || resource.path === null) {
		resolveLoaders(context, request.loaders, options, sync, function(err) {
			if(err) return callback(err);
			return onResolvedBoth();
		});
	} else {
		// Loaders are specified. Do it parallel.
		var fastExit = false;
		var count = 0;

		resolve(context, resource, options, type, sync, function(err) {
			if(err && !fastExit) {
				fastExit = true;
				return callback(err);
			}
			if(count++) return onResolvedBoth();
		});
		resolveLoaders(context, request.loaders, options, sync, function(err) {
			if(err && !fastExit) {
				fastExit = true;
				return callback(err);
			}
			if(count++) return onResolvedBoth();
		});
	}
	function onResolvedBoth() {
		if(request.resource && request.resource.query && options.disableResourceQuery)
			return callback(new Error("Resource query is disabled"));
		if(request.resource && request.resource.query && !request.resource.path && options.disableResourcePureQuery)
			return callback(new Error("Resource pure query is disabled"));
		if(request.loaders && options.disableLoaderQuery) {
			for(var i = 0; i < request.loaders.length; i++) {
				if(request.loaders[i].query && options.disableLoaderQuery)
					return callback(new Error("Loader query is disabled"));
			}
		}
		var intermediateResult = stringify(request);
		var postprocessors = options.postprocess[type].slice(0);
		postprocessors.push(function(result) {
			callback(null, result);
		});
		(function next(err, result) {
			if(err)
				return callback(new Error("File \"" + intermediateResult + "\" is blocked by postprocessors: " + err));
			var postprocessor = postprocessors.shift();
			if(typeof postprocessor == "string") postprocessor = require.valueOf()(postprocessor);
			postprocessor(result, next);
		})(null, intermediateResult);
	}
}

function resolveLoaders(context, loaders, options, sync, callback) {
	var count = loaders.length;
	if(count == 0) return callback();
	var errors = [];
	function endOne(err) {
		if(err) {
			errors.push(err);
		}
		count--;
		if(count === 0) {
			if(errors.length > 0) {
				callback(new Error(errors.join("\n")));
				return;
			}
			callback(null, loaders);
		}
	}
	loaders.forEach(function(loader) {
		resolve(context, loader, options, "loader", sync, endOne);
	});
}

function doComplete(context, identifier, options, type, sync, callback) {
	var request;
	try {
		request = parse(identifier);
	} catch(e) { return callback(e); }
	if(request.loaders) {
		(sync?iterateSync:iterateAsync)(request.loaders, function(loader, idx, next) {
			completePart(context, loader, options, "loader", sync, function(err, result) {
				if(err) return callback(err);
				if(!result) return next();
				result.forEach(function(item) {
					request.loaders[idx] = parse.part(item.part);
					item.result = stringify(request);
				});
				return callback(null, sortCompleteResults(result));
			});
		}, function() {
			continueResource();
		});
	} else continueResource();

	function continueResource() {
		if(request.resource && request.resource.path) {
			// try it as resource and as loader
			completePart(context, request.resource, options, type, sync, function(err, result) {
				if(err) return callback(err);
				if(result)
					result.forEach(function(item) {
						var oldResource = request.resource;
						request.resource = parse.part(item.part);
						item.result = stringify(request);
						request.resource = oldResource;
					});
				if(!result) result = [];
				if(request.resource.path.slice(-1) == "*" && request.resource.query === null && !options.disableLoaders) {
					completePart(context, request.resource, options, "loader", sync, function(err, resultLoader) {
						request.resource = null;
						if(err) return callback(err);
						if(resultLoader) {
							resultLoader.forEach(function(item) {
								if(result.filter(function(ri) {
									return ri.insert == item.insert;
								}).length > 0) return;
								if(!request.loaders) request.loaders = [];
								request.loaders.push(parse.part(item.part));
								item.result = stringify(request);
								request.loaders.pop();
								item.seqment += "!";
								item.insert += "!";
								result.push(item);
							});
						}
						return callback(null, sortCompleteResults(result));
					});
				} else
					return callback(null, sortCompleteResults(result));
			});
		} else callback(null, null);
	}
}

function sortCompleteResults(results) {
	results.sort(function(a, b) {
		if(a.insert == b.insert) return 0;
		return a.insert < b.insert ? -1 : 1;
	});
	for(var i = 1; i < results.length; i++) {
		if(results[i].insert == results[i-1].insert) {
			results.splice(i, 1);
			i--;
		}
	}
	return results;
}

function completePart(context, part, options, type, sync, callback) {
	if(!part.path) return callback();
	// find the "*"
	var idx = part.path.indexOf("*");
	if(idx < 0) return callback();

	// return some basic completes for "./" and "../"
	// Complete absolute path starting is not enabled
	switch(part.path) {
	case ".*":
		return callback(null, [
			{
				insert: "/",
				seqment: "./",
				part: part.query ? "./" + part.query : "./"
			},
			{
				insert: "./",
				seqment: "../",
				part: part.query ? "../" + part.query : "../"
			}
		]);
	case "..*":
		return callback(null, [
			{
				insert: "/",
				seqment: "../",
				part: part.query ? "../" + part.query : "../"
			}
		]);
	}
	if(part.path.slice(-3) == "/.*") {
		return callback(null, [
			{
				insert: "./",
				seqment: "../",
				part: part.path.replace("*", "./") + (part.query ? part.query : "")
			}
		]);
	}
	if(part.path.slice(-4) == "/..*") {
		return callback(null, [
			{
				insert: "/",
				seqment: "../",
				part: part.path.replace("*", "/") + (part.query ? part.query : "")
			}
		]);
	}

	// check if we want to complete a module name
	if(part.module) {
		var idxSlash = part.path.indexOf("/");
		if(idxSlash < 0 || idx < idxSlash) {
			// It's a module string to compele
			var moduleStr = idxSlash >= 0 ? part.path.slice(0, idxSlash) : part.path;

			// delegate it to the module name completion method
			return completeModule(context, moduleStr, options, type, sync, function(err, result) {
				if(err) return callback(err);
				if(!result) return callback(null, null);

				result.forEach(function(item) {
					// There is a special case if module is complete typed and
					// insert position is at the end, we offer to complete the slash
					// TODO check for module is directory
					if(item.insert == "" && part.path.slice(-1) == "*") {
						result.push({
							insert: "/",
							seqment: item.seqment + "/"
						});
					}
				});

				// completeModule only returns insert and seqment
				// we have to add part here
				result.forEach(function(item) {
					var oldPath = part.path;
					part.path = part.path.replace("*", item.insert);
					item.part = stringify.part(part);
					part.path = oldPath;
				});

				// if we complete from the beginning like "*test" or "*"
				// we also offer to switch to relative paths
				// except for empty module names followed by "/", like "*/"
				if(part.path.slice(0, 1) == "*" && part.path.slice(1, 2) != "/") {
					result.unshift({
						insert: "./",
						seqment: "./",
						part: part.query ? "./" + part.path.slice(1) + part.query : "./" + part.path.slice(1)
					}, {
						insert: "../",
						seqment: "../",
						part: part.query ? "../" + part.path.slice(1) + part.query : "../" + part.path.slice(1)
					});
				}
				return callback(null, result);
			});
		}
	}
	// extract the left "/" or "\\" before "*"
	var idxStarting1 = part.path.slice(0, idx).lastIndexOf("/");
	var idxStarting2 = part.path.slice(0, idx).lastIndexOf("\\");
	var idxStarting = Math.max(idxStarting1, idxStarting2);

	// If there is no slash left from the "*"
	// that is weird and we return nothing to complete
	// (I know no case where this can occur)
	if(idxStarting < 0) return callback(null, null);

	// get the starting, which is the path before the left slash
	// we handle this as if the user has finished typing here
	var starting = part.path.slice(0, idxStarting);

	// get the right "/" or "\\" after "*"
	// or default to the full length if no found
	var idxSeqmentEnd1 = part.path.slice(idx).indexOf("/");
	if(idxSeqmentEnd1 < 0)
		idxSeqmentEnd1 = part.path.length;
	else
		idxSeqmentEnd1 = idx + idxSeqmentEnd1;
	var idxSeqmentEnd2 = part.path.slice(idx).indexOf("\\");
	if(idxSeqmentEnd2 < 0)
		idxSeqmentEnd2 = part.path.length;
	else
		idxSeqmentEnd2 = idx + idxSeqmentEnd2;
	var idxSeqmentEnd = Math.min(idxSeqmentEnd1, idxSeqmentEnd2);

	// get the pathEnd, which is the path after the right slash
	// it's not used for resolving, because the user may not finished typing it
	// it's just appended to the part
	var pathEnd = part.path.slice(idxSeqmentEnd);

	// start and end of the sequement to complete
	var seqmentStart = part.path.slice(idxStarting+1, idx);
	var seqmentEnd = part.path.slice(idx+1, idxSeqmentEnd);

	// resolve the starting as context (directory)
	// if this results in an error it is returned and should be reported
	// to the user, as starting is handled as finished
	var parsedStarting = parse.part(starting);
	if(parsedStarting && parsedStarting.path) resolve(context, parsedStarting, options, type === "loader" ? "loader-context" : "context", sync, onResolved);
	else onResolved(null, {path:"/"});
	function onResolved(err, resolvedStarting) {
		if(err) return callback(err);

		// get the directory name and read the content
		var dirname = resolvedStarting.path;
		(sync?readdirSync:readdirAsync)(dirname, function(err, files) {
			if(err) return callback(err);
			var results = [];
			var count = 1;
			var extensions = type === "loader" ? options.loaderExtensions : options.extensions;

			if(/^(\.\.\/)+\*$/.test(part.path) && parsedStarting && parsedStarting.path && parsedStarting.path != "/") {
				results.push({
					insert: "../",
					seqment: "../",
					part: "../" + part.path.slice(0, part.path.length-1) + (part.query ? part.query : "")
				});
			}


			// get possible shortcuts for all files "a.js" -> ["a", "a.js"]
			var seqments = cutExtensions(files, extensions);
			seqments.forEach(function(file) {

				// check if file matches the allready typed starting and ending of the seqment
				if(file.indexOf(seqmentStart) !== 0) return;
				if(file.length < seqmentEnd.length ||
					file.lastIndexOf(seqmentEnd) !== file.length - seqmentEnd.length) return;

				// read stats of file. keep in mind that this is maybe only a shortcut and we have to expand it to get the pathname
				count++;
				var fullFilename = findFileExtensionFromList(files, extensions, file);
				(sync?statSync:statAsync)(path.join(dirname, fullFilename), function(err, stat) {
					if(err) return endOne(err);

					// There is a special case if the user typed a directory and the insert position is at the end
					// than we can complete to a slash, so the slash don't have to be typed
					if(seqmentEnd === "" && pathEnd === "" && stat.isDirectory() && fullFilename == seqmentStart) {
						results.push({
							insert: "/",
							seqment: file + "/",
							part: starting + "/" + file + "/" + (part.query ? part.query : "")
						});
					}

					// The default case is to complete to the shortcutted filename
					// directories cannot be shortcutted with a file extension, so we filter these here
					// NOTE: it seem the be better to filter these before iterating, but this would cause more calls to stat
					//       if the user already typed something. We want to minimize the calls to stat.
					if(!stat.isDirectory() || fullFilename == file) {
						results.push({
							insert: file.slice(seqmentStart.length, file.length - seqmentEnd.length),
							seqment: file,
							part: starting + "/" + file + pathEnd + (part.query ? part.query : "")
						});
					}
					return endOne();
				});
			});
			endOne();
			var errored = false;
			function endOne(err) {
				if(errored) return;
				if(err) {
					errored = true;
					return callback(err);
				}
				if(--count == 0)
					return callback(null, results);
			}
		});
	}
}

function cutExtensions(files, extensions) {
	var set = {};
	files.forEach(function(file) {
		extensions.forEach(function(ext) {
			if(file.length < ext.length) return;
			if(file.lastIndexOf(ext) != file.length - ext.length) return;
			set[file.slice(0, file.length - ext.length)] = true;
		});
	});
	return Object.keys(set);
}

function findFileExtensionFromList(files, extensions, file) {
	for(var i = 0; i < extensions.length; i++) {
		if(files.indexOf(file + extensions[i]) >= 0)
			return file + extensions[i];
	}
	return file;
}

function completeModule(context, identifier, options, type, sync, callback) {
	var idx = identifier.indexOf("*");
	if(idx < 0) return callback();
	var starting = identifier.slice(0, idx);
	var ending = identifier.slice(idx+1);
	var results = [];
	var paths = modulesDirectoriesPaths(context, options);
	options.paths.forEach(function(path) {
		paths.push(path);
	});
	Object.keys(options.alias).forEach(testModule);
	var prefixes = type === "loader" ? options.loaderPostfixes : options.postfixes;
	var extensions = type === "loader" ? options.loaderExtensions : options.extensions;
	var both = prefixes.slice();
	extensions.forEach(function(i) { both.push(i) });
	var count = paths.length;
	paths.forEach(function(path) {
		(sync?statSync:statAsync)(path, function(err, stat) {
			if(err || !stat || !stat.isDirectory())
				return endOne();
			(sync?readdirSync:readdirAsync)(path, function(err, files) {
				files = cutExtensions(files, both);
				files.forEach(testModule);
				endOne();
			});
		});
	});
	function testModule(file) {
		if(file.indexOf(starting) != 0) return;
		if(file.length < ending.length || file.lastIndexOf(ending) != file.length - ending.length) return;
		results.push({
			insert: file.slice(starting.length, file.length - ending.length),
			seqment: file
		});
	}
	function endOne() {
		if(--count == 0) {
			return callback(null, results);
		}
	}
}


/**
 * sets not defined options to node.js defaults
 */
function setupDefaultOptions(options) {
	if(!options)
		options = {};
	if(!options.extensions)
		options.extensions = ["", ".js"];
	if(!options.loaders)
		options.loaders = [];
	if(!options.postfixes)
		options.postfixes = [""];
	if(!options.packageMains)
		options.packageMains = ["main"];
	if(!options.loaderExtensions)
		options.loaderExtensions = [".node-loader.js", ".loader.js", "", ".js"];
	if(!options.loaderPostfixes)
		options.loaderPostfixes = ["-node-loader", "-loader", ""];
	if(!options.loaderPackageMains)
		options.loaderPackageMains = ["loader", "main"];
	if(!options.paths)
		options.paths = [];
	if(!options.modulesDirectories)
		options.modulesDirectories = ["node_modules"];
	if(!options.alias)
		options.alias = {};
	if(!options.postprocess)
		options.postprocess = {};
	if(!options.postprocess.normal)
		options.postprocess.normal = [];
	if(!options.postprocess.context)
		options.postprocess.context = [];
	return options;
}

function createSyncCallback() {
	var err, result;
	function fn(_err, _result) {
		err = _err;
		result = _result;
	}
	fn.get = function() {
		if(err) throw err;
		return result;
	}
	return fn;
}

/**
 * context: absolute filename of current file
 * identifier: module to find
 * options:
 *   paths: array of lookup paths
 * callback: function(err, absoluteFilename)
 */
var resolveFunction = function resolveFunction(context, identifier, options, callback) {
	if(!callback) {
		callback = options;
		options = {};
	}
	options = setupDefaultOptions(options);
	return doResolve(context, identifier, options, "normal", false, callback);
}
resolveFunction.sync = function(context, identifier, options) {
	if(!options) options = {};
	options = setupDefaultOptions(options);
	var callback = createSyncCallback();
	doResolve(context, identifier, options, "normal", true, callback);
	return callback.get();
}
resolveFunction.setupDefaultOptions = setupDefaultOptions;

resolveFunction.context = function(context, identifier, options, callback) {
	if(!callback) {
		callback = options;
		options = {};
	}
	options = setupDefaultOptions(options);
	return doResolve(context, identifier, options, "context", false, callback);
}
resolveFunction.context.sync = function(context, identifier, options) {
	if(!options) options = {};
	options = setupDefaultOptions(options);
	var callback = createSyncCallback();
	doResolve(context, identifier, options, "context", true, callback);
	return callback.get();
}

/**
 * callback: function(err, absoluteFilenamesArray)
 */
resolveFunction.loaders = function(context, identifier, options, callback) {
	if(!callback) {
		callback = options;
		options = {};
	}
	options = setupDefaultOptions(options);
	try {
		var loaders = parse(identifier + "!").loaders;
	} catch(e) { return callback(e); }
	return resolveLoaders(context, loaders, options, false, function(err, loaders) {
		if(err) return callback(err);
		return callback(null, loaders.map(stringify.part));
	});
}
resolveFunction.loaders.sync = function(context, identifier, options) {
	if(!options) options = {};
	options = setupDefaultOptions(options);
	var callback = createSyncCallback();
	var loaders = parse(identifier + "!").loaders;
	resolveLoaders(context, loaders, options, false, callback);
	return callback.get().map(stringify.part);
}
resolveFunction.parse = parse;
resolveFunction.stringify = stringify;


/**
 * Complete identifier at "*".
 * Returns an array of possibilities: (i. e. "loader!module/fi*.js?query")
 * [{
 *  insert: "le", // text to insert
 *  seqment: "file.js",
 *  result: "loader!module/file.js?query"
 * }]
 * returns an empty array if there are no valid possibilities "missingMod*"
 * returns null if there is nothing to complete "module?qu*"
 * throws an exception if there are multiple/no "*"
 */
resolveFunction.complete = function(context, identifier, options, callback) {
	if(!callback) {
		callback = options;
		options = {};
	}
	options = setupDefaultOptions(options);
	return doComplete(context, identifier, options, "normal", false, callback);
}
resolveFunction.complete.sync = function(context, identifier, options) {
	if(!options) options = {};
	options = setupDefaultOptions(options);
	var callback = createSyncCallback();
	doComplete(context, identifier, options, "normal", true, callback);
	return callback.get();
}


function split(a) {
	return a.split(/[\/\\]/g);
}

function join(a, b) {
	var c = [];
	a.forEach(function(x) { c.push(x) });
	b.forEach(function(x) { c.push(x) });
	if(c[0] === "") // fix *nix paths
		c[0] = "/";
	return path.join.apply(path, c);
}

function loadAsFile(filename, options, type, sync, callback) {
	var extensions = type === "loader" ? options.loaderExtensions : options.extensions;
	var tries = extensions.map(function(ext) {
		return filename + ext;
	});
	var count = tries.length;
	var results = tries.slice(0);
	tries.forEach(function forEachTryFn(test, idx) {
		(sync?statSync:statAsync)(test, function loadAsFileTryCallback(err, stat) {
			results[idx] = (err || !stat || !stat.isFile()) ? null : test;
			count--;
			if(count === 0) {
				for(var i = 0; i < tries.length; i++) {
					if(results[i]) return callback(null, tries[i]);
				}
				var notFoundErr = new Error("Non of this files exists: " + tries.join(", "));
				notFoundErr.notImportant = true;
				return callback(notFoundErr);
			}
		});
	});
}

function loadAsDirectory(dirname, options, type, sync, callback) {
	(sync?statSync:statAsync)(dirname, function(err, stats) {
		if(err || !stats || !stats.isDirectory()) {
			var notFoundErr = new Error(dirname + " is not a directory");
			notFoundErr.notImportant = true;
			return callback(notFoundErr);
		}
		var packageJsonFile = join(split(dirname), ["package.json"]);
		(sync?statSync:statAsync)(packageJsonFile, function(err, stats) {
			var mainModule = "index";
			if(!err && stats.isFile()) {
				(sync?readFileSync:readFileAsync)(packageJsonFile, "utf-8", function(err, content) {
					if(err) {
						err.notImportant = true;
						callback(err);
						return;
					}
					try {
						content = parsePackage(content);
					} catch (jsonError) {
						return callback(jsonError);
					}
					var packageMains = type === "loader" || type === "loader-context" ? options.loaderPackageMains : options.packageMains;
					for(var i = 0; i < packageMains.length; i++) {
						if(Array.isArray(packageMains[i])) {
							var current = content;
							for(var j = 0; j < packageMains[i].length; j++) {
								if(current === null || typeof current !== "object") {
									current = null;
									break;
								}
								var field = packageMains[i][j];
								current = current[field];
							}
							if(current) {
								mainModule = current;
								i = packageMains.length;
								break;
							}
						} else {
							var field = packageMains[i];
							if(content[field]) {
								mainModule = content[field];
								break;
							}
						}
					}
					loadAsFile(join(split(dirname), [mainModule]), options, type, sync, function(err, absoluteFilename) {
						if(!err) return callback(null, absoluteFilename);
						loadAsFile(join(split(dirname), [mainModule, "index"]), options, type, sync, function(err2, absoluteFilename) {
							if(!err2) return callback(null, absoluteFilename);
							err.notImportant = true;
							return callback(err);
						})
					});
				});
			} else
				loadAsFile(join(split(dirname), [mainModule]), options, type, sync, callback);
		});
	});
}

function loadAsFileOrDirectory(pathname, options, type, sync, callback) {
	var result = null;
	var counter = 0;
	var error = null;
	var fastExit = false;
	loadAsFile(pathname, options, type, sync, function loadAsFileOrDirectoryFileResultCallback(err, absoluteFilename) {
		if(err) {
			if(!err.notImportant || !error) error = err;
		} else {
			fastExit = true;
			return callback(null, absoluteFilename);
		}
		if(counter++) bothDone();
	});
	loadAsDirectory(pathname, options, type, sync, function loadAsFileOrDirectoryDirectoryResultCallback(err, absoluteFilename) {
		if(err) {
			if(!error || (error.notImportant && !err.notImportant)) error = err;
		} else {
			result = absoluteFilename;
		}
		if(counter++) bothDone();
	});
	function bothDone() {
		if(fastExit) return;
		if(result)
			callback(null, result);
		else
			callback(error);
	}
}

function loadInModuleDirectories(context, identifier, options, type, sync, callback) {
	var firstError = null;
	var fileInModule = split(identifier);
	var moduleName = fileInModule.shift();
	var postfixes = type === "loader" || type === "loader-context" ? options.loaderPostfixes : options.postfixes;
	if(postfixes.length == 0) return callback(new Error("Loading these modules is disabled"));
	var paths = modulesDirectoriesPaths(context, options);
	(sync?iterateSync:iterateAsync)(options.paths, function(path, idx, next) {
		usePath(path, next);
	}, function() {
		(sync?iterateSync:iterateAsync)(paths, function(path, idx, next) {
			(sync?statSync:statAsync)(path, function(err, stat) {
				if(err || !stat || !stat.isDirectory())
					return next();
				usePath(path, next);
			});
		}, function() {
			callback(firstError || new Error("non in any path of paths"));
		});
	});
	function usePath(path, next) {
		var dirs = [];
		postfixes.forEach(function(postfix) {
			dirs.push(join(split(path), [moduleName+postfix]));
		});
		var count = dirs.length;
		var results = dirs.slice(0);
		var fastExit = false;
		dirs.forEach(function(dir, idx) {
			var pathname = join(split(dir), fileInModule);
			if(type === "context" || type === "loader-context") {
				(sync?statSync:statAsync)(pathname, function(err, stat) {
					if(err && !firstError) firstError = err;
					results[idx] = (err || !stat.isDirectory()) ? null : pathname;
					endOne(idx);
				});
			} else {
				loadAsFileOrDirectory(pathname, options, type, sync, function loadAsFileOrDirectoryCallback(err, absoluteFilename) {
					if(err && !firstError) firstError = err;
					results[idx] = err ? null : absoluteFilename;
					endOne(idx);
				});
			}
		});
		function endOne(idx) {
			if(fastExit) return;
			count--;
			if(count === 0) {
				for(var i = 0; i < results.length; i++) {
					if(results[i])
						return callback(null, results[i]);
				}
				next();
			} else if(results[idx]) {
				for(var i = 0; i < idx; i++) {
					if(results[i])
						return;
				}
				fastExit = true;
				return callback(null, results[idx]);
			}
		}
	}
}

function modulesDirectoriesPaths(context, options) {
	var parts = split(context);
	var root = 0;
	options.modulesDirectories.forEach(function(dir) {
		var index = parts.indexOf(dir)-1;
		if(index >= 0 && index < root)
			root = index;
	});
	var dirs = [];
	for(var i = parts.length; i > root; i--) {
		if(options.modulesDirectories.indexOf(parts[i-1]) >= 0)
			continue;
		var part = parts.slice(0, i);
		options.modulesDirectories.forEach(function(dir) {
			dirs.push(join(part, [dir]));
		});
	}
	return dirs;
}

function iterateAsync(array, fn, cb) {
	var i = 0;
	(function next() {
		var item = array[i++];
		if(!item) return cb();
		return fn(item, i-1, next);
	})();
}

function iterateSync(array, fn, cb) {
	var cond = true;
	for(var i = 0; i < array.length && cond; i++) {
		cond = false;
		fn(array[i], i, next);
	}
	if(cond) cb();
	function next() {
		cond = true;
	}
}

return resolveFunction;

}
