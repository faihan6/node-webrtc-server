class Offset{

    constructor(initValue = 0){
        this.position = initValue;
    }

    returnAndIncrement(times){
        const val = this.position;
        this.position += times;
        return val;
    }
}

class CustomEventTarget{

    listeners = {};

    constructor(){}

    addEventListener(type, listener){

        if(!this.listeners[type]){
            this.listeners[type] = [];
        }

        this.listeners[type].push(listener);
    }

    dispatchEvent(name, ...args){
        if(!this.listeners[name]){
            return;
        }
        for(const listener of this.listeners[name]){
            listener(...args);
        }
    }

    removeEventListener(type, listener){
        if(!this.listeners[type]){
            return;
        }

        this.listeners[type] = this.listeners[type].filter(l => l != listener);
    }
}

function getFormattedHexBuffer(buffer){
    return buffer?.toString('hex').match(/.{2}/g)?.join(' ') || buffer?.toString('hex');
}

DataView.prototype.getUint24 = function(offset){
    return this.getUint16(offset) * 256 + this.getUint8(offset + 2);
}

function setUInt24(buffer, offset, value){
    try{
        buffer.writeUInt16BE((value >> 8) & 0xffff, offset);
        buffer.writeUInt8(value & 0xff, offset + 2);
    }
    catch(err){
        console.error('Error setting UInt24', err, buffer, offset, value);
    }
}

function ntpToTimeMs(msw, lsw){
    
    const unixTime = msw - 2208988800;
    const fraction = lsw / (2 ** 32);

    const time = unixTime + fraction;

    return time * 1000
    
}

module.exports = {
    Offset, getFormattedHexBuffer, ntpToTimeMs, CustomEventTarget, setUInt24
}