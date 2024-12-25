const { initializeSignalling } = require("./src/mediaserver/signalling");
const { initializeDTLS } = require("./src/webrtc/dtls");

const fs = require('fs');
const toml = require('toml');

const configFile = fs.readFileSync('server-config.toml');
const config = toml.parse(configFile);

initializeConfig(config);
initializeDTLS(config.certificatePath, config.keyPath);
initializeSignalling()

function initializeConfig(config){
    console.log('Config is..', config);
    Object.keys(config).forEach(key => {
        globalThis[key] = config[key];
    })
}
