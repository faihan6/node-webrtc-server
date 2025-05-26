const fs = require('fs');

if(!fs.existsSync('server-config.js')){
    console.log('Generating server-config.js...');
    fs.copyFileSync('example-server-config.js', 'server-config.js');
}
else{
    console.log('Not generating server-config.js because it already exists.');
}


