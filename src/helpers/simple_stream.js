const { CustomEventTarget } = require('./common_helper');

class SimpleStream extends CustomEventTarget{

    constructor(){
        super();
    }
    
    write(data){
        // console.log('Writing data to stream');
        this.dispatchEvent('data', data);
    }

}

module.exports = {
    SimpleStream
}