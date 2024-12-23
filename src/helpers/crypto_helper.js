const crypto = require('crypto');
const crc32 = require('crc32');

DataView.prototype.setUint24 = function(byteOffset, value) {
    this.setUint8(byteOffset, (value >> 16) & 0xff);
    this.setUint16(byteOffset + 1, value & 0xffff);
}

DataView.prototype.setUint48 = function(byteOffset, value) {
    this.setUint32(byteOffset, value >> 16);
    this.setUint16(byteOffset + 4, value & 0xffff);
}

async function sha256(buffer) {
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(byte => byte.toString(16).toUpperCase().padStart(2, '0')).join('');
    return hashHex;
}

function generateRandomString(length) {
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';

    for (let i = 0; i < length; i++) {
        const randomIndex = Math.floor(Math.random() * characters.length);
        result += characters.charAt(randomIndex);
    }

    return result;
}

function calculateSHA1(buffer, password) {
    const hmac = crypto.createHmac('sha1', password);
    hmac.update(buffer);
    const sha1Hash = hmac.digest();
    return sha1Hash;
}

function calculateCRC32(inputArrayBuffer) {
  const inputBuffer = Buffer.from(inputArrayBuffer);
  const crc32Result = crc32(inputBuffer);
  return parseInt(crc32Result, 16);
}

function hmacHash(secret, seed){
    const hmac = crypto.createHmac('sha256', Buffer.from(secret));
    hmac.update(seed);
    return hmac.digest();
}

function pHash(secret, seed){

    function A(i){
        if(i === 0){
            return seed;
        }
        else{
            return hmacHash(secret, A(i-1));
        }
    }

    return Buffer.concat([
        hmacHash(secret, Buffer.concat([A(1), seed])),
        hmacHash(secret, Buffer.concat([A(2), seed])),
        hmacHash(secret, Buffer.concat([A(3), seed])),
        hmacHash(secret, Buffer.concat([A(4), seed])),
    ]);

}

function PRF(secret, label, seed, length){

    const labelSeedConcat = [];
    if(label){
        labelSeedConcat.push(label);
    }
    if(seed){
        labelSeedConcat.push(seed);
    }

    return pHash(secret, Buffer.concat(labelSeedConcat)).slice(0, length);
}

module.exports = {
    sha256,
    generateRandomString,
    calculateSHA1,
    calculateCRC32,
    PRF
};