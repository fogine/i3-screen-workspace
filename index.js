//deps: xrandr,notify-send,drm,i3-msg,dmenu|rofi,node
var path     = require('path');
var fs       = require('fs');
var spawnSync = require('child_process').spawnSync;

var DRM_CARD = process.env.DRM_CARD || '/sys/class/drm/card0';
var $HOME = process.env.HOME;
var CARD = path.basename(DRM_CARD);
var CONFIG = path.join($HOME, '.config', 'i3-screen-workspace', 'config.json');
var conf;

//load required configuration
try {
    conf = JSON.parse(fs.readFileSync(CONFIG).toString());

    if (!(conf.outputs instanceof Array) || !conf.outputs.length) {
        console.error(`WARN:Unsatisfactory workspace/outputs configuration. Nothing to do, exiting..`);
        return process.exit(0);
    }
} catch(e) {
    if (e.code === 'ENOENT') {
        console.error(`Please create your ${CONFIG} configuration file`);
    } else {
        console.error(e);
    }

    return process.exit(1);
}

//parse device edids and display output names from xrandr output
var xrandrOutputs = parseOutputEDIDs(xrandrCmd(['--prop']));
//save currently focused workspace so we can get back to it
var currentWorkspace = JSON.parse(
    i3cmd(['-t', 'get_workspaces'])
).find(function(workspace) {
    return workspace.focused;
});

//get list of available display outputs (ports)
var outputs = getOutputs(DRM_CARD);
var connectedOutputs = outputs.filter(function(output) {
    return output.connected;
});

//assign unique xrandr names to the connected outputs
//(they are not same as names found under /sys/class/drm/card0/card0-<name>)
//also assign additional xrandr options from the configuration file
connectedOutputs.forEach(function(output) {
    var outputConfig;
    var xrandrOutput = xrandrOutputs[output.edid];
    if (xrandrOutput) {
        outputConfig = conf.outputs.find(function(output) {
            return output.name === xrandrOutput.name;
        });
        output['xrandr-name'] = xrandrOutput.name;
        if (outputConfig && outputConfig.xrandr) {
            output.xrandr = outputConfig.xrandr;
        }
    }
});

var connectedOutputNames = connectedOutputs.map(function(output) {
    return output['xrandr-name'];
});

conf.outputs = conf.outputs.filter(function(output) {
    return connectedOutputNames.includes(output.name);
});
var _confWorkspaces = conf.outputs.map(function(output) {
    return output.workspaces;
});

//asign workspaces to correct outputs according to configuration
var i3cmdChain = '';
conf.outputs.forEach(function(output, index) {

    if (conf.outputs[index + 1] === undefined) {
        i3cmdChain += buildCmdChain(output.name, output.workspaces);
        return;
    }

    var workspaces = _confWorkspaces.slice(index + 1);
    workspaces.unshift(output.workspaces);
    output.workspaces = difference.apply(this, workspaces);
    i3cmdChain += buildCmdChain(output.name, output.workspaces);
});

/**
 * @param {String} output (eg.: HDMI-A-1)
 * @param {Array<String>} workspaces
 *
 * @return {String}
 */
function buildCmdChain(output, workspaces) {
    var cmd = '';

    workspaces.forEach(function(workspace) {
        cmd += `workspace ${workspace}; move workspace to output ${output}; `;
    });

    return cmd;
}

connectedOutputs.forEach(function(output) {
    var args = ['--output', output['xrandr-name'], '--auto'];
    if (output.xrandr instanceof Array) {
        args = args.concat(output.xrandr);
    }
    return xrandrCmd(args);
});

i3cmd(i3cmdChain);
i3cmd(`workspace ${currentWorkspace.name}`);



/*===========================================================================*/

/**
 * getOutputs
 * @param {String} drmCardDir - usually /sys/class/drm/card0
 * @return {Object}
 */
function getOutputs(drmCardDir) {
    var out = [];
    var card = path.basename(drmCardDir);
    fs.readdirSync(drmCardDir).forEach(function(file) {
        var enabled
        ,   status
        ,   segments = file.match(new RegExp(`^${card}-([a-zA-Z0-9-]+)$`))
        ,   pth = path.join(drmCardDir, file)
        ,   isDir = fs.lstatSync(pth).isDirectory();

        if (!segments || !isDir) {
            return;
        }

        enabled = fs.readFileSync(path.join(pth, 'enabled')).toString().trim();
        status = fs.readFileSync(path.join(pth, 'status')).toString().trim();
        edid = fs.readFileSync(path.join(pth, 'edid')).toString('hex').trim();

        out.push({
            path: pth,
            name: segments[1],
            edid: edid,
            enabled: enabled === 'enabled',
            connected: status === 'connected'
        });
    });

    return out;
}

/**
 * @param {String|Array<String>} cmd - i3-msg cmd
 * @return {String} - stdout
 */
function i3cmd(cmd) {

    var result = spawnSync('i3-msg', cmd instanceof Array ? cmd : [cmd]);

    if (result.status !== 0) {
        console.error(`i3-msg ${command}  exited with status ${result.status}`);
        console.error(result.stderr.toString());
        return process.exit(1);
    }

    return result.stdout.toString();
}

/**
 * @return {String}
 */
function xrandrCmd(args) {
    var result = spawnSync('xrandr', args);

    if (result.status !== 0) {
        console.error(`xrandr exited with status ${result.status}`);
        console.error(result.stderr.toString());
        return process.exit(1);
    }

    return result.stdout.toString();
}


/**
 * @param {Array<String>} arr - array
 * @param {Array<String>..} arrays
 *
 * @return {Array<String>}
 */
function difference(arr/*, array2, array3, ...*/) {
    var isPresent;
    var out = [];
    var arrays = Array.prototype.slice.call(arguments, 1);

    for (var i = 0, len = arr.length; i < len; i++) {
        isPresent = false;
        loop2: for (var y = 0, lenY = arrays.length; y < lenY; y++) {
            for (var z = 0, lenZ = arrays[y].length; z < lenZ; z++) {
                if (arrays[y][z].includes(arr[i])) {
                    isPresent = true;
                    break loop2;
                }
            }
        }
        if (!isPresent) {
            out.push(arr[i]);
        }
    }

    return out;
}

/**
 * @param {String} data - stdout of xrandr --prop
 * @return {Object}
 */
function parseOutputEDIDs(data) {
    var type = {
        connected: /^(\S+) connected (?:(\d+)x(\d+)\+(\d+)\+(\d))*\s*(\(\w+\))*\s*(\w*)/,
        disconnected: /^(\S+) disconnected/,
        edid: /^\s+EDID:\s*$/,
    };
    var lines = data.split('\n');
    var result = [];
    var last_connection = null;

    lines.forEach(function (line, i) {
            var tmp;
            if ((tmp = type.connected.exec(line))) {
                result.push({
                    connected: true,
                    name: tmp[1]
                });
                last_connection = result.length - 1;
            } else if ((tmp = type.disconnected.exec(line))) {
                result.push({
                    connected: false,
                    name: tmp[1]
                });
                last_connection = result.length - 1;
            } else if ((tmp = type.edid.exec(line))) {
                var edid = lines.slice(i+1).reduce(function(edid, line) {
                    if (edid.length < 256) {
                        edid += line.trim();
                    }
                    return edid;
                }, '');

                result[last_connection].edid = edid;
            }
    });

    return result.reduce(function(out, item) {
        out[item.edid] = item;
        return out;
    }, {});
}
