var inited = false;

// Editor socket
// TODO: Factor this out somehow
var timeOut = 2000;
var reconnectTimeout = null;
var pingInterval = null;
var pongTimeout = null;
var editorSocketConn;
var currentSocketOptions = {};
var openProjects = {};

function init() {
    var require = window.require;
    var nodeRequire = window.nodeRequire;
    var gui = require("nw.gui");
    inited = true;
    var Promise = window.Promise;


    function openEditor(title, url) {
        var w = gui.Window.open('editor.html?url=' + encodeURIComponent(url) + '&title=' + encodeURIComponent(title), {
            position: 'center',
            width: 800,
            height: 600,
            frame: true,
            toolbar: false,
            icon: "Icon.png"
        });
        return new Promise(function(resolve) {
            w.once("loaded", function() {
                w.focus();
                resolve({
                    addCloseListener: function(listener) {
                        w.on("closed", function() {
                            listener();
                        });
                    },
                    window: w.window,
                    focus: function() {
                        w.focus();
                    }
                });
            });
        });
    }


    function initEditorSocket(server) {
        function createUUID() {
            var s = [];
            var hexDigits = "0123456789ABCDEF";
            for (var i = 0; i < 32; i++) {
                s[i] = hexDigits.substr(Math.floor(Math.random() * 0x10), 1);
            }
            s[12] = "4";
            s[16] = hexDigits.substr((s[16] & 0x3) | 0x8, 1);

            var uuid = s.join("");
            return uuid;
        }

        var userKey = window.localStorage.zedremUserKey ? JSON.parse(window.localStorage.zedremUserKey) : null;
        if (!userKey) {
            userKey = createUUID();
            window.localStorage.zedremUserKey = JSON.stringify(userKey);
        }
        currentSocketOptions = {
            server: server,
            userKey: userKey
        };
        editorSocket(currentSocketOptions);
    }


    function closeSocket() {
        if (editorSocketConn) {
            if (reconnectTimeout) {
                clearTimeout(reconnectTimeout);
            }
            if (pingInterval) {
                clearInterval(pingInterval);
            }
            if (pongTimeout) {
                clearTimeout(pongTimeout);
            }
            editorSocketConn.onclose = function() {};
            editorSocketConn.close();
        }
    }

    function editorSocket(zedremConfig) {
        if (!zedremConfig.server) {
            // You can disable connecting to zedrem by setting server to null or false
            return;
        }
        console.log("Attempting to connect to", zedremConfig.server + "/editorsocket");
        editorSocketConn = new window.WebSocket(zedremConfig.server + '/editorsocket');
        editorSocketConn.onopen = function() {
            console.log("Connected to zedrem server!");
            editorSocketConn.send(JSON.stringify({
                version: "1",
                UUID: zedremConfig.userKey
            }));
            timeOut = 2000;
            pingInterval = setInterval(function() {
                console.log("Ping");
                editorSocketConn.send(JSON.stringify({
                    type: "ping"
                }));
                pongTimeout = setTimeout(function() {
                    console.log("Ping timed out, reconnecting...");
                    closeSocket();
                    initEditorSocket(zedremConfig.server);
                }, 3000);
            }, 5000);
        };
        editorSocketConn.onerror = function(err) {
            console.error("Socket error", err);
        };
        editorSocketConn.onmessage = function(e) {
            var message = e.data;
            try {
                message = JSON.parse(message);
                switch (message.type) {
                    case 'pong':
                        clearTimeout(pongTimeout);
                        pongTimeout = null;
                        console.log("Got pong");
                        break;
                    case 'open':
                        var url = zedremConfig.server.replace("ws://", "http://").replace("wss://", "https://") + "/fs/" + message.url;
                        console.log("Now have ot open URL:", url);
                        openEditor("Remote", url);
                        break;
                }
            } catch (e) {
                console.error("Couldn't deserialize:", message, e);
            }
        };
        editorSocketConn.onclose = function(e) {
            // console.log("Close", e);
            if (timeOut < 5 * 60 * 1000) { // 5 minutes max
                timeOut *= 2;
            }
            closeSocket();
            console.log("Socket closed, retrying in", timeOut / 1000, "seconds");
            reconnectTimeout = setTimeout(function() {
                editorSocket(zedremConfig);
            }, timeOut);
        };
    }

    exports.initEditorSocket = initEditorSocket;

    // OPEN PROJECTS
    exports.openProject = function(title, url) {
        console.log("Going to open", title, url, Object.keys(openProjects));
        if (openProjects[url]) {
            openProjects[url].focus();
        } else {
            openEditor(title, url);
        }
    };

    exports.registerWindow = function(url, win) {
        console.log("Registered", url, win);
        openProjects[url] = win;
        win.on("close", function() {
            process.stdout.write("Closed a window: " + url);
            delete openProjects[url];
        });
    };

    // SELF UPDATE

    try {
        update();
    } catch (e) {
        console.error("Error", e.message);
    }

    function update() {
        var downloadUrl = "http://download.zedapp.org/";
        var $ = window.$;

        var path = nodeRequire("path");
        var http = nodeRequire("http");
        var fs = nodeRequire("fs");
        var zlib = nodeRequire('zlib');
        var tar = nodeRequire('tar');
        var os = nodeRequire('os');
        var gui = nodeRequire("nw.gui");
        var exec = nodeRequire("child_process").exec;

        // gui.Window.get().showDevTools();

        var applicationPath;
        var updated = false;

        if (process.platform === "darwin") {
            // Get to the path to the .app directory
            applicationPath = path.dirname(path.dirname(path.dirname(path.dirname(path.dirname(path.dirname(process.execPath))))));
        } else {
            applicationPath = path.dirname(process.execPath);
        }

        checkForUpdate();

        // Check very 3h
        setInterval(checkForUpdate, 1000 * 60 * 60 * 3);

        function checkForUpdate() {
            if (updated) {
                // Already updated, no need to check again
                return;
            }
            var currentVersion;
            console.log("Checking for update");
            getCurrentVersion().then(function(currentVersion_) {
                currentVersion = currentVersion_;
                return getNewVersion();
            }).then(function(newVersion) {
                console.log("Current version", currentVersion, "new version", newVersion);
                // currentVersion = "0.0"; // Force upgrade
                if (versionCompare(newVersion, currentVersion) > 0) {
                    return upgrade(newVersion).then(function() {
                        updated = true;
                        $("#update-available").fadeIn();
                    }, function(err) {
                        return showUpdateError(typeof err === "string" ? err : err.message);
                    });
                } else {
                    console.log("No upgrade required");
                }
            }).
            catch (function(err) {
                return showUpdateError("Couldn't check for updated version. No internet connection?");
            });
        }

        function showUpdateError(message) {
            console.error("Update error", message);
        }

        function getCurrentVersion() {
            return new Promise(function(resolve, reject) {
                $.get("app://./manifest.json", function(text) {
                    var json = JSON.parse(text);
                    resolve(json.version);
                }).error(function(err) {
                    reject(err);
                });
            });
        }

        function getNewVersion() {
            return new Promise(function(resolve, reject) {
                $.get(downloadUrl + "current-version.txt", function(text) {
                    resolve(text.trim());
                }).error(function(err) {
                    reject(err);
                });
            });
        }

        function downloadVersion(version) {
            var downloadFilename = "zed-";
            switch (process.platform) {
                case "darwin":
                    downloadFilename += "mac";
                    break;
                case "linux":
                    if (process.arch === "ia32") {
                        downloadFilename += "linux32";
                    } else {
                        downloadFilename += "linux64";
                    }
                    break;
                case "win32":
                    downloadFilename += "win";
                    break;
                default:
                    return Promise.reject("Platform not supported for auto updates");
            }
            downloadFilename += "-v" + version + ".tar.gz";
            var newAppDir = path.normalize(applicationPath + "/../zed.update");
            try {
                fs.mkdirSync(newAppDir);
            } catch (e) {
                if (e.errno === -17) {
                    console.log("Directory already exists, that's ok.");
                } else {
                    return Promise.reject(e);
                }
            }
            return new Promise(function(resolve, reject) {
                http.get(downloadUrl + downloadFilename, function(res) {
                    res.pipe(zlib.createGunzip()).pipe(tar.Extract({
                        path: newAppDir
                    })).on("error", function(err) {
                        reject(err);
                    });
                    res.on("end", function() {
                        resolve(newAppDir);
                    });
                    res.on("error", function(e) {
                        reject(e);
                    });
                }).on('error', function(e) {
                    reject(e);
                });
            });
        }

        function upgrade(version) {
            console.log("Upgrading...");
            return downloadVersion(version).then(function(outDir) {
                console.log("Downloaded");
                var win = gui.Window.get();
                var dirName = outDir + "/zed";
                if (process.platform === "darwin") {
                    dirName = outDir + "/Zed.app";
                }
                // Attaching to close handler, when the project picker is
                // closed, the upgrade will take place
                win.on("close", function() {
                    // For windows we generate a batch file that is launched
                    // asynchronously, and does the switcharoo while Zed is not
                    // running to avoid locking errors.
                    if (process.platform === "win32") {
                        var batchScriptPath = os.tmpdir() + "zed-update.bat";
                        fs.writeFileSync(batchScriptPath,
                            "echo Will update Zed in 5 seconds...\n\
                                    timeout /t 5 /nobreak\n\
                                    move \"" + applicationPath + "\" \"" + applicationPath + ".prev\"\n\
                                    move \"" + dirName + "\" \"" + applicationPath + "\"\n\
                                    rmdir /S /Q \"" + outDir + "\"\n\
                                    rmdir /S /Q \"" + applicationPath + ".prev\"\n\
                                    exit");
                        exec("start " + batchScriptPath);
                        setTimeout(function() {
                            process.exit(0);
                        }, 1000);
                    } else {
                        // Linux and Mac are more lenient, we can switch out files
                        // without many problems.
                        try {
                            fs.renameSync(applicationPath, applicationPath + ".prev");
                            fs.renameSync(dirName, applicationPath);
                            deleteFolderRecursive(outDir);
                            deleteFolderRecursive(applicationPath + ".prev");
                            this.close(true);
                        } catch (e) {
                            console.error("Failed to rename", e);
                        }
                    }
                });
            });
        }

        function deleteFolderRecursive(path) {
            var files = [];
            if (fs.existsSync(path)) {
                files = fs.readdirSync(path);
                files.forEach(function(file) {
                    var curPath = path + "/" + file;
                    if (fs.lstatSync(curPath).isDirectory()) { // recurse
                        deleteFolderRecursive(curPath);
                    } else { // delete file
                        fs.unlinkSync(curPath);
                    }
                });
                fs.rmdirSync(path);
            }
        }


        /**
         * Code taken from:
         * http://stackoverflow.com/questions/6832596/how-to-compare-software-version-number-using-js-only-number
         * copyright by Jon Papaioannou
         * This function is in the public domain. Do what you want with it, no strings attached.
         */
        function versionCompare(v1, v2, options) {
            var lexicographical = options && options.lexicographical,
                zeroExtend = options && options.zeroExtend,
                v1parts = v1.split('.'),
                v2parts = v2.split('.');

            function isValidPart(x) {
                return (lexicographical ? /^\d+[A-Za-z]*$/ : /^\d+$/).test(x);
            }

            if (!v1parts.every(isValidPart) || !v2parts.every(isValidPart)) {
                return NaN;
            }

            if (zeroExtend) {
                while (v1parts.length < v2parts.length) {
                    v1parts.push("0");
                }
                while (v2parts.length < v1parts.length) {
                    v2parts.push("0");
                }
            }

            if (!lexicographical) {
                v1parts = v1parts.map(Number);
                v2parts = v2parts.map(Number);
            }

            for (var i = 0; i < v1parts.length; ++i) {
                if (v2parts.length === i) {
                    return 1;
                }

                if (v1parts[i] === v2parts[i]) {
                    continue;
                } else if (v1parts[i] > v2parts[i]) {
                    return 1;
                } else {
                    return -1;
                }
            }

            if (v1parts.length !== v2parts.length) {
                return -1;
            }

            return 0;
        }

    }

}

exports.init = init;

exports.configZedrem = function(newServer) {
    if (!inited) {
        init();
    }
    if (currentSocketOptions.server !== newServer) {
        exports.initEditorSocket(newServer);
    }
};


process.on('uncaughtException', function(err) {
    process.stdout.write('Caught exception: ' + err);
});
