const { initializeSignalling } = require("./src/mediaserver/signalling");
const { initializeDTLS } = require("./src/webrtc/dtls");
const { pid } = require('process');
const { monitorEventLoopDelay } = require('perf_hooks');

const fs = require('fs');
const toml = require('toml');

const configFile = fs.readFileSync('server-config.toml');
const config = toml.parse(configFile);

function initializeConfig(config){
    console.log('Config is..', config);
    Object.keys(config).forEach(key => {
        globalThis[key] = config[key];
    })
}

console.log('Process running on PID', pid)

initializeConfig(config);
initializeDTLS(config.certificatePath, config.keyPath);
initializeSignalling()

const histogram = monitorEventLoopDelay();
histogram.enable();

let prevData;

setInterval(() => {

    const eventLoopDelay = histogram.mean / 1e6;
    const maxEventLoopDelay = histogram.max / 1e6;
    histogram.reset();

    const usage = process.cpuUsage();
    const userCPUtime = usage.user / 1000;
    const systemCPUtime = usage.system / 1000;

    if(!prevData){
        prevData = {eventLoopDelay, maxEventLoopDelay, userCPUtime, systemCPUtime};
    }
    else{
        const userCPUtimeDiff = userCPUtime - prevData.userCPUtime;
        const systemCPUtimeDiff = systemCPUtime - prevData.systemCPUtime;

        prevData = {eventLoopDelay, maxEventLoopDelay, userCPUtime, systemCPUtime};

        console.log(`Event loop delay: ${eventLoopDelay.toFixed(2)} ms | Max Event loop delay: ${maxEventLoopDelay.toFixed(2)} ms | User CPU time diff: ${userCPUtimeDiff.toFixed(2)} ms | System CPU time diff: ${systemCPUtimeDiff.toFixed(2)} ms`);
    }



    //console.log(`Event loop delay: ${eventLoopDelay.toFixed(2)} ms | Max Event loop delay: ${maxEventLoopDelay.toFixed(2)} ms | User CPU time: ${userCPUtime.toFixed(2)} ms | System CPU time: ${systemCPUtime.toFixed(2)} ms`);
}, 1000);

