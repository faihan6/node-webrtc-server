const crypto = require('crypto');
const { PRF } = require('../helpers/crypto_helper');
const {RTPContext} = require('./rtp');

const DIV = (a, t) => t ? Math.floor(a / t) : 0;
const TLS_EXTRACTOR_LABEL = Buffer.from('EXTRACTOR-dtls_srtp', 'utf8');

const PROFILE_CONSTANTS = {
    0x0001: 'SRTP_AES128_CM_HMAC_SHA1_80',
    0x0007: 'SRTP_AEAD_AES_128_GCM',
    0x0008: 'SRTP_AEAD_AES_256_GCM',
}

const PROFILE_PARAMS = {
    SRTP_AES128_CM_HMAC_SHA1_80: {
        cipher: "AES_128_CM",
        cipherKeyLengthBits: 128,
        cipherSaltLengthBits: 112,
        maximumLifetime: 2 ** 31,
        authFunction: "HMAC_SHA1",
        authKeyLengthBits: 160,
        authTagLengthBits: 80,
    },
    SRTP_AEAD_AES_128_GCM: {
        cipher: "AES_128_GCM",
        cipherKeyLengthBits: 128,
        cipherSaltLengthBits: 96,
        maximumLifetime: 2 ** 31,
        authFunction: null,
        authKeyLengthBits: 0,
        authTagLengthBits: 0,
    },
}

/**
 * This class takes care of encrypting and decrypting SRTP packets.
 * Processing is taken care by the super (RTPContext) class.
 * Actual writing on the wire and actual listening from the wire are outside the scope of this class.
 */
class SRTPContext extends RTPContext{
    keyDerivationRate = 0x00;
    srtpMasterKeyLength = 16; // bytes
    srtpMasterSaltLength = 14; // bytes

    /** Maps SSRCs with last known sequence number on that SSRC and last used ROC for that SSRC */
    rocSeqNoWithSSRCMap = {};

    srtpParams = {
        clientKeys: {},
        serverKeys: {}
    }

    tlsData = null;
    areKeysDerived = false;

    srtcpIndexCount = {}

    constructor({onPacketReadyToSend, onRTPPacketReadyForApplication}){
        super({onPacketReadyToSend, onRTPPacketReadyForApplication});
    }


    initSRTP(tlsParams){

        this.tlsData = tlsParams;
        //console.log('DTLS-SRTP Params:', this, this.tlsData);

        const index = 0;
        const masterKeys = this.deriveSRTPMasterKeysFromDTLSData(index);

        if(masterKeys.srtpClientWriteMasterKey && masterKeys.srtpClientWriteMasterSalt){
            this.srtpParams.clientKeys = this.deriveSRTPSessionKeys(masterKeys.srtpClientWriteMasterKey, masterKeys.srtpClientWriteMasterSalt, index);
            // console.log(`
            //     client - srtpEncryptionKey  : ${this.srtpParams.clientKeys.srtpEncryptionKey.toString('hex')}
            //     client - srtpAuthKey        : ${this.srtpParams.clientKeys.srtpAuthenticationKey.toString('hex')}
            //     client - srtpSaltKey        : ${this.srtpParams.clientKeys.srtpSaltKey.toString('hex')}
            //     client - srtcpEncryptionKey : ${this.srtpParams.clientKeys.srtcpEncryptionKey.toString('hex')}
            //     client - srtcpAuthKey       : ${this.srtpParams.clientKeys.srtcpAuthenticationKey.toString('hex')}
            //     client - srtcpSaltKey       : ${this.srtpParams.clientKeys.srtcpSaltKey.toString('hex')}
            // `);
        }
    
        if(masterKeys.srtpServerWriteMasterKey && masterKeys.srtpServerWriteMasterSalt){
            this.srtpParams.serverKeys = this.deriveSRTPSessionKeys(masterKeys.srtpServerWriteMasterKey, masterKeys.srtpServerWriteMasterSalt, index);
            // console.log(`
            //     server - srtpEncryptionKey  : ${this.srtpParams.serverKeys.srtpEncryptionKey.toString('hex')}
            //     server - srtpAuthKey        : ${this.srtpParams.serverKeys.srtpAuthenticationKey.toString('hex')}
            //     server - srtpSaltKey        : ${this.srtpParams.serverKeys.srtpSaltKey.toString('hex')}
            //     server - srtcpEncryptionKey : ${this.srtpParams.serverKeys.srtcpEncryptionKey.toString('hex')}
            //     server - srtcpAuthKey       : ${this.srtpParams.serverKeys.srtcpAuthenticationKey.toString('hex')}
            //     server - srtcpSaltKey       : ${this.srtpParams.serverKeys.srtcpSaltKey.toString('hex')}
            // `);
        }
    
    }
    
    // By spec, need to call this every `keyDerivationRate` packets
    deriveSRTPMasterKeysFromDTLSData(index){
    
        index = index || 0;

        //console.log(this)
    
        const seed = Buffer.concat([this.tlsData.clientRandom, this.tlsData.serverRandom]);
        const srtpKeyBlock = PRF(this.tlsData.masterSecret, TLS_EXTRACTOR_LABEL, seed, 2 * (this.srtpMasterKeyLength + this.srtpMasterSaltLength));
    
        //console.log('Keying Material', srtpKeyBlock.toString('hex'));
    
    
        const srtpClientWriteMasterKey = srtpKeyBlock.slice(0, this.srtpMasterKeyLength);
        const srtpServerWriteMasterKey = srtpKeyBlock.slice(this.srtpMasterKeyLength, 2 * this.srtpMasterKeyLength);
        const srtpClientWriteMasterSalt = srtpKeyBlock.slice(2 * this.srtpMasterKeyLength, 2 * this.srtpMasterKeyLength + this.srtpMasterSaltLength);
        const srtpServerWriteMasterSalt = srtpKeyBlock.slice(2 * this.srtpMasterKeyLength + this.srtpMasterSaltLength, 2 * (this.srtpMasterKeyLength + this.srtpMasterSaltLength));
    
        // console.log(`
        //     srtpClientWriteMasterKey : ${srtpClientWriteMasterKey.toString('hex')}
        //     srtpServerWriteMasterKey : ${srtpServerWriteMasterKey.toString('hex')}
        //     srtpClientWriteMasterSalt: ${srtpClientWriteMasterSalt.toString('hex')}
        //     srtpServerWriteMasterSalt: ${srtpServerWriteMasterSalt.toString('hex')}`
        // )
    
        return {
            srtpClientWriteMasterKey,
            srtpServerWriteMasterKey,
            srtpClientWriteMasterSalt,
            srtpServerWriteMasterSalt
        }
    
        
    
    }
    
    deriveSRTPSessionKeys(masterKey, masterSalt, index){
    
        const currentProfile = PROFILE_CONSTANTS[this.tlsData.srtpProfile];
        const currentProfileParams = PROFILE_PARAMS[currentProfile];
    
        const srtpEncryptionKey = this.srtpKDFForLabel2(masterKey, masterSalt, Buffer.from([0x00]), index, currentProfileParams.cipherKeyLengthBits / 8);
        const srtpAuthenticationKey = this.srtpKDFForLabel2(masterKey, masterSalt, Buffer.from([0x01]), index, currentProfileParams.authKeyLengthBits / 8);
        const srtpSaltKey = this.srtpKDFForLabel2(masterKey, masterSalt, Buffer.from([0x02]), index, currentProfileParams.cipherSaltLengthBits / 8);
    
        const srtcpEncryptionKey = this.srtpKDFForLabel2(masterKey, masterSalt, Buffer.from([0x03]), index, currentProfileParams.cipherKeyLengthBits / 8);
        const srtcpAuthenticationKey = this.srtpKDFForLabel2(masterKey, masterSalt, Buffer.from([0x04]), index, currentProfileParams.authKeyLengthBits / 8);
        const srtcpSaltKey = this.srtpKDFForLabel2(masterKey, masterSalt, Buffer.from([0x05]), index, currentProfileParams.cipherSaltLengthBits / 8);
    
        return {
            srtpEncryptionKey,
            srtpAuthenticationKey,
            srtpSaltKey,
            srtcpEncryptionKey,
            srtcpAuthenticationKey,
            srtcpSaltKey
        }
    
    }
    
    /**
     * SRTP KDF as specified in RFC 3711.
     *
     * @param {Buffer} masterKey - The master key.
     * @param {Buffer} masterSalt - The master salt.
     * @param {number} labelBuffer - The label (0-255) as a single byte buffer.
     * @param {number} index - The rollover counter (ROC) or session-specific index as a 6-byte buffer.
     * @param {number} length - The desired length of the output keying material.
     * @returns {Buffer} - The derived keying material of the specified length.
     */
    srtpKDFForLabel2(masterKey, masterSalt, labelBuffer, index, length) {
    
        if(!index){
            //console.log('No index given, setting it to zero');
            index = 0;
        }
    
        const r = DIV(index, this.keyDerivationRate);
        const rBuffer = Buffer.alloc(6);
        rBuffer.writeUIntBE(r, 0, 6);
    
        const keyId = Buffer.concat([labelBuffer, rBuffer]);
    
        // we need to XOR keyId with master salt.
        // master salt is 14 bytes long, keyId is 7 bytes long.
        // we need to pad keyId with 7 zero on the left.
        const paddedKeyId = Buffer.alloc(14);
        keyId.copy(paddedKeyId, 7);
    
        const x = Buffer.alloc(14);
        for (let i = 0; i < 14; i++) {
            x[i] = masterSalt[i] ^ paddedKeyId[i];
        }
    
        const iv = Buffer.concat([x, Buffer.alloc(2)]);
        const cipher = crypto.createCipheriv('aes-128-ctr', masterKey, iv);
        const encrypted = Buffer.concat([cipher.update(Buffer.alloc(length)), cipher.final()]);
    
        if(!length){
            return Buffer.from([]);
        }
    
        // Return the requested length
        return encrypted.slice(0, length);
    
    }
    
    handlePacketFromRemote(packet, remote){

        const version = packet[0] >> 6;
        if(version != 2){
            console.error('Invalid version');
            return;
        }
    
        const byte2 = packet[1];
        const payloadType = byte2 & 0b01111111;
    
    
        
        let decrypted;
    
        if(payloadType == 96){
            decrypted = this.decryptSRTP(packet, this.srtpParams.clientKeys);

        }
        else{
            decrypted = this.decryptSRTCP(packet, this.srtpParams.clientKeys);      
        }
        super.handlePacketFromRemote(decrypted);

    }

    
    decryptSRTP(packet, keys){
    
        const sequenceNumber = packet.readUInt16BE(2);
    
        // TODO: why get it as integer from buffer and then convert to buffer again?
        const ssrc = packet.readUInt32BE(8);
        const ssrcBuffer = Buffer.alloc(4);
        ssrcBuffer.writeUIntBE(ssrc, 0, 4);

        const index = this.predictRTPIndex(ssrc, sequenceNumber);
        const indexBuffer = Buffer.alloc(6);
        indexBuffer.writeUIntBE(index, 0, 6);
    
        const iv = this.getIV(keys.srtpSaltKey, ssrcBuffer, indexBuffer);
        const encryptedPayload = packet.slice(12, packet.length - 10);
        const authTag = packet.slice(packet.length - 10);
    
        // verify auth tag
    
        const roc = this.rocSeqNoWithSSRCMap[ssrc].lastKnownROC;
        const rocBuffer = Buffer.alloc(4);
        rocBuffer.writeUIntBE(roc, 0, 4);
    
        const authenticatedPortionWithROC = Buffer.concat([packet.slice(0, packet.length - 10), rocBuffer]);
    
        const hmac = crypto.createHmac('sha1', keys.srtpAuthenticationKey);
        hmac.update(authenticatedPortionWithROC);
        const calculatedAuthTag = hmac.digest().slice(0, 10);
    
        if(!calculatedAuthTag.equals(authTag)){
            console.error(`Auth tag mismatch: calculated: ${calculatedAuthTag.toString('hex')}, packet: ${authTag.toString('hex')}`);
        }
        else{
            //console.log('Auth tag verified');
        }
    
        const cipher = crypto.createDecipheriv('aes-128-ctr', keys.srtpEncryptionKey, iv);
    
        const decryptedPayload = Buffer.concat([
            cipher.update(encryptedPayload),
            cipher.final()
        ]);
    
    
        //console.log('encryptedPayload:', encryptedPayload.toString('hex'));
        //console.log('decryptedPayload:', decryptedPayload);
    
        return Buffer.concat([packet.slice(0, 12), decryptedPayload]);
        
        
    }

    decryptSRTCP(packet, keys){

        const authTagStartIndex = packet.length - 10;
        /** technically 31 bytes (1 bit less than 4 byes) before start of authTagStartIndex. We will take care of it in the next step */
        const srtcpIndexNoStartIndex = authTagStartIndex - 4;
        const encryptedPayloadStartIndex = 8;


        const authTagBuffer = packet.slice(authTagStartIndex);
        const isEncrypted = packet[srtcpIndexNoStartIndex] >> 7

        const srtcpIndexValueBuffer = Buffer.alloc(4);
        packet.copy(srtcpIndexValueBuffer, 0, srtcpIndexNoStartIndex, authTagStartIndex);
        srtcpIndexValueBuffer[0] = srtcpIndexValueBuffer[0] & 0b01111111;

        const ssrcBuffer = packet.slice(4, 8);
        const iv = this.getIV(keys.srtcpSaltKey, ssrcBuffer, srtcpIndexValueBuffer);

        const encryptedPayload = packet.slice(encryptedPayloadStartIndex, srtcpIndexNoStartIndex);
        const authenticatedPortion = packet.slice(0, authTagStartIndex);

        //console.log(`authTagStartIndex: ${authTagStartIndex}, srtcpIndexNoStartIndex: ${srtcpIndexNoStartIndex}, encryptedPayloadStartIndex: ${encryptedPayloadStartIndex}`);
        //console.log(`isEncrypted: ${isEncrypted}, srtcpIndexValueBuffer: ${srtcpIndexValueBuffer.toString('hex')}, ssrcBuffer: ${ssrcBuffer.toString('hex')}, iv: ${iv.toString('hex')}, authTagBuffer: ${authTagBuffer.toString('hex')}`);
        //console.log(`encryptedPayload: ${encryptedPayload.toString('hex')}, authenticatedPortion: ${authenticatedPortion.toString('hex')}`)


        const hmac = crypto.createHmac('sha1', keys.srtcpAuthenticationKey);
        hmac.update(authenticatedPortion);
        const calculatedAuthTag = hmac.digest().slice(0, 10);

        if(!calculatedAuthTag.equals(authTagBuffer)){
            console.error(`Auth tag mismatch: calculated: ${calculatedAuthTag.toString('hex')}, packet: ${authTagBuffer.toString('hex')}`);
        }
        else{
           // console.log('Auth tag verified for RTCP');
        }

        if(isEncrypted){
            const cipher = crypto.createDecipheriv('aes-128-ctr', keys.srtcpEncryptionKey, iv);
            const decryptedPayload = Buffer.concat([
                cipher.update(encryptedPayload),
                cipher.final()
            ]);

            return Buffer.concat([packet.slice(0, encryptedPayloadStartIndex), decryptedPayload]);
        }

        return packet.slice(0, authTagStartIndex);



        
    }
    
    /**
     * 
     * @param {Buffer} saltingKeyBuffer - 14 bytes
     * @param {Buffer} ssrcBuffer - 4 bytes
     * @param {Buffer} packetIndexBuffer - 6 bytes
     * @param {Number} counter 
     * @returns ivBuffer
     */
    getIV(saltingKeyBuffer, ssrcBuffer, packetIndexBuffer){
    
        const ivSegment = Buffer.alloc(16);
        const paddedSalt = Buffer.concat([saltingKeyBuffer, Buffer.alloc(16 / 8)]);
        const paddedSSRC = Buffer.concat([ssrcBuffer, Buffer.alloc(64 / 8)]);
        const paddedPacketIndex = Buffer.concat([packetIndexBuffer, Buffer.alloc(16 / 8)]);
    
        for(let i = 0; i < 16; i++){
            const saltByte = paddedSalt[paddedSalt.length - 1 - i] || 0;
            const ssrcByte = paddedSSRC[paddedSSRC.length - 1 - i] || 0;
            const packetIndexByte = paddedPacketIndex[paddedPacketIndex.length - 1 - i] || 0;
    
            ivSegment[ivSegment.length - 1 - i] = saltByte ^ ssrcByte ^ packetIndexByte;
        }
    
        return ivSegment;
         
    }

    sendPacketToRemote(packet){

        if(!Object.keys(this.srtpParams.serverKeys).length){
            console.error('SRTP keys not set');
            return;
        }


        let encryptedPacket;
        let type;
        if((packet[1] & 0b01111111) == 96){
            type = 'RTP';
            this.processRTPBeforeSending(packet);
            encryptedPacket = this.encryptRTP(packet, this.srtpParams.serverKeys);
        }
        else{
            type = 'RTCP';
            encryptedPacket = this.encryptRTCP(packet, this.srtpParams.serverKeys);
        }

        this.sendPacketToRemoteCallback(encryptedPacket);
    }

    encryptRTP(packet, keys){
        
            const sequenceNumber = packet.readUInt16BE(2);
        
            const ssrc = packet.readUInt32BE(8);
            const ssrcBuffer = Buffer.alloc(4);
            ssrcBuffer.writeUIntBE(ssrc, 0, 4);

            const index = this.getRTPIndex(ssrc, sequenceNumber);
            const indexBuffer = Buffer.alloc(6);
            indexBuffer.writeUIntBE(index, 0, 6);
        
            const iv = this.getIV(keys.srtpSaltKey, ssrcBuffer, indexBuffer, 0);
            const payload = packet.slice(12);
        
            const cipher = crypto.createCipheriv('aes-128-ctr', keys.srtpEncryptionKey, iv);
        
            const encryptedPayload = Buffer.concat([
                cipher.update(payload),
                cipher.final()
            ]);
        
            const roc = this.rocSeqNoWithSSRCMap[ssrc].lastKnownROC;
            const rocBuffer = Buffer.alloc(4);
            rocBuffer.writeUIntBE(roc, 0, 4);
        
            const authenticatedPortionWithROC = Buffer.concat([packet.slice(0, 12), encryptedPayload, rocBuffer]);
        
            const hmac = crypto.createHmac('sha1', keys.srtpAuthenticationKey);
            hmac.update(authenticatedPortionWithROC);
            const authTag = hmac.digest().slice(0, 10);
        
            const encryptedPacket = Buffer.concat([packet.slice(0, 12), encryptedPayload, authTag]);
            return encryptedPacket;
    }

    encryptRTCP(packet, keys){

        const ssrcBuffer = packet.slice(4, 8);
        const ssrc = ssrcBuffer.readUInt32BE(0);
        if(!this.srtcpIndexCount[ssrc]){
            console.log('No index count found for ssrc', ssrc);
            this.srtcpIndexCount[ssrc] = 0;
        }
        else{
            //console.log('Index count found for ssrc', ssrc, this.srtcpIndexCount[ssrc]);
        }
        
        const index = this.srtcpIndexCount[ssrc]++;
        const indexBuffer = Buffer.alloc(4);
        indexBuffer.writeUIntBE(index, 0, 4);

        const iv = this.getIV(keys.srtcpSaltKey, ssrcBuffer, indexBuffer);

        // since we are encrypting, we need to set the MSB of index to 1
        indexBuffer[0] = indexBuffer[0] | 0b10000000;

        const payload = packet.slice(8);
        const cipher = crypto.createCipheriv('aes-128-ctr', keys.srtcpEncryptionKey, iv);
        const encryptedPayload = Buffer.concat([
            cipher.update(payload),
            cipher.final()
        ]);

        const authenticatedPortion = Buffer.concat([
            packet.slice(0, 8),
            encryptedPayload,
            indexBuffer
        ])

        const hmac = crypto.createHmac('sha1', keys.srtcpAuthenticationKey);
        hmac.update(authenticatedPortion);
        const authTag = hmac.digest().slice(0, 10);

        const encryptedPacket = Buffer.concat([
            packet.slice(0, 8),
            encryptedPayload,
            indexBuffer,
            authTag
        ]);

        return encryptedPacket;
    }

    predictRTPIndex(ssrc, sequenceNumber){

        if(this.rocSeqNoWithSSRCMap[ssrc] == undefined){
            this.rocSeqNoWithSSRCMap[ssrc] = {
                lastKnownROC: 0,
                lastKnownSequenceNumber: 0
            }
        }

        const {lastKnownROC, lastKnownSequenceNumber} = this.rocSeqNoWithSSRCMap[ssrc];
        let predictedROC;

        if(sequenceNumber >= lastKnownSequenceNumber){
            predictedROC = lastKnownROC;
        }
        else{
            if(lastKnownSequenceNumber - sequenceNumber > (1 << 15)){
                predictedROC = lastKnownROC + 1;
            }
            else{
                predictedROC = lastKnownROC;
            }
        }

        this.rocSeqNoWithSSRCMap[ssrc] = {
            lastKnownROC: predictedROC,
            lastKnownSequenceNumber: sequenceNumber
        }
        

        return ((2 ** 16) * predictedROC) + sequenceNumber;
    }

    getRTPIndex(ssrc, sequenceNumber){
        if(this.rocSeqNoWithSSRCMap[ssrc] == undefined){
            this.rocSeqNoWithSSRCMap[ssrc] = {
                lastKnownROC: 0,
            }
        }

        if(sequenceNumber == 0){
            this.rocSeqNoWithSSRCMap[ssrc].lastKnownROC++;
        }

        const {lastKnownROC} = this.rocSeqNoWithSSRCMap[ssrc];
        return ((2 ** 16) * lastKnownROC) + sequenceNumber;
    }

}


        

module.exports = {
    SRTPContext
}