const fs = require('fs');
const { execSync } = require('child_process');

// Generate server-config.js if it doesn't exist
if(!fs.existsSync('server-config.js')){
    console.log('Generating server-config.js...');
    fs.copyFileSync('example-server-config.js', 'server-config.js');
}
else{
    console.log('Not generating server-config.js because it already exists.');
}

// Generate certificates if they don't exist
if(!fs.existsSync('certificates')){
    console.log('Generating certificates...');
    fs.mkdirSync('certificates');
    execSync('openssl ecparam -name prime256v1 -genkey -noout -out certificates/key.pem');
    execSync('openssl req -x509 -key certificates/key.pem -days 365 -out certificates/cert.pem -subj "/CN=localhost"');
}

