'use strict';

var glob    = require('glob');
var async   = require('async');
var path    = require('path');
var fs      = require('fs');
var mkdirp  = require('mkdirp');
var mv      = require('mv');

module.exports = function (task) {
    task
    .id('mv')
    .name('Move')
    .description('Move files and folders.')
    .author('Indigo United')

    .option('files', 'Which files should be moved. Accepts an object in which keys are the source files and values the destination. Source values support minimatch.')
    .option('glob', 'The options to pass to glob (check https://npmjs.org/package/glob for details).', null)

    .do(function (opt, ctx, next) {
        opt.glob = opt.glob || {};
        var sources = Object.keys(opt.files);
        var error;

        // Cycle through each source
        // Note that series is used to avoid conflicts between each pattern
        async.forEachSeries(sources, function (pattern, next) {
            var dst = opt.files[pattern];
            pattern = path.normalize(pattern);

            // Expand the files to get an array of files and directories
            expand(pattern, opt.glob, function (err, files, dirs, directMatch) {
                if (err) {
                    return next(err);
                }

                if (!files.length && !dirs.length) {
                    error = new Error('ENOENT, no such file or directory \'' + pattern + '\'');
                    error.code = 'ENOENT';
                    return next(error);
                }

                // Process the matches
                if (directMatch) {
                    processDirectMatch(files, dirs, dst, ctx, next);
                } else {
                    processPatternMatch(pattern, files, dirs, dst, ctx, next);
                }
            });
        }, next);
    });
};

/**
 * Processes a direct match.
 *
 * @param {Array}    files The files
 * @param {Array}    dirs  The directories
 * @param {String}   dst   The destination
 * @param {Object}   ctx   The context
 * @param {Function} next  The callback to call with the files and folders (follows node conventions)
 */
function processDirectMatch(files, dirs, dst, ctx, next) {
    var src = files[0] || dirs[0];
    var srcType = files[0] === src ? 'file' : 'dir';
    var dstType;
    var error;
    var tmp;

    // Ensure the dirname of the dst exists
    mkdirp(path.dirname(dst), function (err) {
        if (err) {
            return next(err);
        }

        // Dst is a folder if:
        //  - if exists and is a folder
        //  - ends with /
        fs.stat(dst, function (err, stat) {
            if (stat) {
                dstType = stat.isFile() ? 'file' : 'dir';
            } else {
                dstType = /[\/\\]$/.test(dst) ? 'dir' : srcType;
            }

            // Check if move is possible
            if (srcType === 'dir' && dstType === 'file') {
                error = new Error('ENODIR, not a directory: \'' + dst + '\'');
                error.code = 'ENODIR';
                return next(error);
            }

            // Folder to folder
            if (srcType === 'dir' && dstType === 'dir') {
                // When moving to a folder that already exists
                // or ends with a /, the user is trying to move the folder
                // inside it
                if (stat || /[\/\\]$/.test(dst)) {
                    tmp = !stat ? dst : null;
                    dst = path.join(dst, path.basename(src));
                }

                if (tmp) {
                    mkdirp(tmp, function (err) {
                        if (err) {
                            return next(err);
                        }

                        move(src, dst, ctx, next);
                    });
                } else {
                    move(src, dst, ctx, next);
                }
            // File to folder
            } else if (srcType === 'file' && dstType === 'dir') {
                // If moving file to dir, ensure that the dir is created
                // and perform a file to file move afterwards
                if (!stat) {
                    fs.mkdir(dst, function (err) {
                        if (err) {
                            return next(err);
                        }

                        dst = path.join(dst, path.basename(src));
                        move(src, dst, ctx, next);
                    });
                } else {
                    dst = path.join(dst, path.basename(src));
                    move(src, dst, ctx, next);
                }
            // File to file is simple
            } else {
                move(src, dst, ctx, next);
            }
        });
    });
}

/**
 * Processes a pattern match.
 *
 * @param {String}   pattern The pattern
 * @param {Array}    files   The files
 * @param {Array}    dirs    The directories
 * @param {String}   dst     The destination
 * @param {Object}   ctx     The context
 * @param {Function} next    The callback to call with the files and folders (follows node conventions)
 */
function processPatternMatch(pattern, files, dirs, dst, ctx, next) {
    files.push.apply(files, dirs);

    async.forEachLimit(files, 30, function (file, next) {
        var currDst = path.join(dst, relativePath(file, pattern));

        mkdirp(path.dirname(currDst), function (err) {
            if (err) {
                return next(err);
            }

            move(file, currDst, ctx, next);
        });
    }, next);
}

/**
 * Moves a file or directory.
 *
 * @param {String}   src  The source
 * @param {String}   dst  The destination
 * @param {Object}   ctx  The context
 * @param {Object}   ctx  The context
 * @param {Function} next The function to call when done (follows node conventions)
 */
function move(src, dst, ctx, next) {
    ctx.log.debugln('Moving ' + src + ' to ' + dst);
    mv(src, dst, next);
}

/**
 * Expands the given minimatch pattern to an array of files and an array of dirs.
 * The dirs are guaranteed to not overlap files.
 *
 * @param {String}   pattern The pattern
 * @param {Object}   options The options to pass to the glob
 * @param {Function} next    The callback to call with the files and folders (follows node conventions)
 */
function expand(pattern, options, next) {
    var files = [];
    var dirs = [];
    var lastMatch = '';

    options = options || {};

    // If the user specified a /**/* pattern, optimize it
    if (!options.glob || !options.glob.noglobstar) {
        pattern = pattern.replace(/(\/\*\*\/\*)+$/g, '/*');
    }

    // Expand with glob
    options.mark = true;
    glob(pattern, options, function (err, matches) {
        if (err) {
            return next(err);
        }

        matches.forEach(function (match) {
            var isFile = !/[\/\\]$/.test(match);

            if (isFile) {
                lastMatch = match;
                files.push(lastMatch);
            } else {
                lastMatch = match.replace(/[\/\\]+$/, '');
                dirs.push(lastMatch);
            }
        });

        // If we only got one match and it was the same as the original pattern,
        // then it was a direct match
        pattern = path.normalize(pattern).replace(/[\/\\]+$/, '');
        lastMatch = path.normalize(lastMatch).replace(/[\/\\]+$/, '');

        var directMatch = matches.length === 1 && lastMatch === pattern;
        if (!directMatch) {
            cleanup(files, dirs);
        }

        next(null, files, dirs, directMatch);
    });
}

/**
 * Takes an array of files and folders and takes care of overlapping.
 * See the expand function for more info.
 *
 * @param {Array} files The array of files
 * @param {Array} dirs  The array of dirs
 */
function cleanup(files, dirs) {
    var x, y;

    // Cleanup files that overlap dirs
    dirs.forEach(function (dir) {
        for (x = files.length - 1; x >= 0; --x) {
            if (path.dirname(files[x]).indexOf(dir) === 0) {
                files.splice(x, 1);
            }
        }
    });

    // Cleanup dirs that overlap eachother
    for (x = 0; x < dirs.length; ++x) {
        for (y = x + 1; y < dirs.length; ++y) {
            if (dirs[y].indexOf(dirs[x]) === 0) {
                dirs.splice(y, 1);
                --x;
                --y;
            }
        }
    }
}

/**
 * Gets the relative path of a file relative to the pattern.
 * For instance:
 *   file = /a/b.js
 *   pattern = /a/*
 *
 * Should return b.js
 *
 * @param {String} file    The file
 * @param {String} pattern The pattern
 *
 * @return {String} The relative path
 */
function relativePath(file, pattern) {
    var length = file.length,
        x;

    pattern = path.normalize(pattern);
    file = path.normalize(file);

    for (x = 0; x < length; ++x) {
        if (file[x] !== pattern[x]) {
            return file.substr(x);
        }
    }

    return path.basename(file);
}