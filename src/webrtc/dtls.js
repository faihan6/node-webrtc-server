const crypto = require('crypto');
const {Offset, CustomEventTarget} = require('../helpers/common_helper');
const { sha256, PRF } = require('../helpers/crypto_helper');
const fs = require('fs');

let selfCertificateFingerprint = null;
let certificateContents = null;
let keyContents = null;

async function getFingerprintOfCertificate() {
    if(!selfCertificateFingerprint){
        await calculateAndSetSelfCertificateFingerprint();
    }
    return selfCertificateFingerprint;
}

async function calculateAndSetSelfCertificateFingerprint(){
    const strippedCertificateContents = certificateContents.replace(/-----BEGIN CERTIFICATE-----\n?/, '').replace(/-----END CERTIFICATE-----\n?/, '');
    const certBuffer = Buffer.from(strippedCertificateContents, 'base64');
    selfCertificateFingerprint = await sha256(certBuffer);
}

function initializeDTLS(certificatePath, keyPath){
    certificateContents = fs.readFileSync(certificatePath, {encoding: 'utf-8'});
    keyContents = fs.readFileSync(keyPath, {encoding: 'utf-8'});
    calculateAndSetSelfCertificateFingerprint();
}

class DTLSContext extends CustomEventTarget{

    strippedCertBuffer = null
    cert = null
    key = null
    sequenceNumber = 0

    clientRandom = null;
    serverRandom = null;

    handshakeMessagesSoFar = []

    serverPrivateKey = null
    serverPublicKey = null
    clientPublicKey = null

    symmetricKeys = null;

    preMasterSecret = null;
    masterSecret = null

    srtpProfile = 0x0001;

    constructor(){
        super();
        this.setCertAndKey(certificateContents, keyContents);
    }

    setCertAndKey(certificateContents, keyContents){
        this.cert = certificateContents;
        let strippedCert = certificateContents.replace(/-----BEGIN CERTIFICATE-----\n?/, '').replace(/-----END CERTIFICATE-----\n?/, '');
        this.strippedCertBuffer = Buffer.from(strippedCert, 'base64');

        this.key = keyContents;
    }

    async calculateFingerprint(certificateBuffer) {
        // Calculate the SHA-256 hash
        const hash = await sha256(certificateBuffer);

        return hash;
    }

    setRemoteFingerprint(fingerprint){
        this.remoteFingerprint = fingerprint;
    }


    handleDTLS(packet){

        let response;

        if(!this.strippedCertBuffer || !this.key){
            return;
        }




        const requestView = new DataView(packet.buffer);

        for(let startPos = 0; startPos < packet.length;){
            const recordType = requestView.getUint8(startPos);
            const version = requestView.getUint16(startPos + 1);
            const epoch = requestView.getUint16(startPos + 3);

            // getUint48 is not a standard function
            const seqNo = requestView.getUint32(startPos + 5) * 0x10000 + requestView.getUint16(startPos + 9);

            const recordLength = requestView.getUint16(startPos + 11);
            
            if(recordType == 0x16){

                const recordData = packet.slice(startPos + 13, startPos + 13 + recordLength);
                //console.log(startPos, "Record data", this._recordSummary(recordData));

                const handShakeType = recordData[0];
                
                if(epoch == 0x00){
                    this.handshakeMessagesSoFar.push(recordData);
                    if(handShakeType == 0x01){
                        response = this.handleClientHello(recordData);
                    }
                    else if(handShakeType == 0x10){
                        // extract clientPublicKey
                        const clientPublicKeyLength = recordData[12]
                        this.clientPublicKey = recordData.slice(13, 13 + clientPublicKeyLength);
                    }
                }
                else{
                    //console.log('Encrypted handshake message arrived, sending change cipher spec and finished');

                    this.preMasterSecret = this.computeSharedSecret(this.clientPublicKey, this.serverPrivateKey);
                    this.masterSecret = this.computeMasterSecret(this.preMasterSecret, this.clientRandom, this.serverRandom);

                    if(globalThis.serverConfig.outputDTLSSecrets){
                        this.writeToKeyLogFile(this.clientRandom, this.masterSecret);
                    }

                    this.dispatchEvent('dtlsParamsReady', {
                        masterSecret: this.masterSecret, 
                        clientRandom: this.clientRandom, 
                        serverRandom: this.serverRandom, 
                        srtpProfile: this.srtpProfile
                    })

                    this.symmetricKeys = this.computeSymmetricKeysFromMasterSecret(this.masterSecret, this.clientRandom, this.serverRandom);

                    this.verifyClientFinished({type: recordType, version, epoch, seqNo, recordLength}, recordData);

                    const changeCipherSpec = this.prepareChangeCipherSpec();
                    const changeCipherSpecHeader = this.prepareRecordHeader(20, 0xfefd, 0, this.sequenceNumber++, changeCipherSpec);

                    const finished = this.prepareFinished();
                    const finishedHeader = this.prepareRecordHeader(0x16, 0xfefd, 1, 0, finished);

                    response = Buffer.concat([
                        // newSessionTicketHeader, 
                        // newSessionTicket, 
                        changeCipherSpecHeader, 
                        changeCipherSpec, 
                        finishedHeader, 
                        finished
                    ]);
                }
                

                startPos += 13 + recordLength;
            }

            else if (recordType == 0x14){
                

                // change cipher spec from client is not a handshake message. its record type is 20
                

                const recordData = packet.slice(startPos + 13, startPos + 13 + recordLength);
                //console.log(startPos, "Record data", this._recordSummary(recordData));
                

                startPos += 13 + recordLength;
                
            }
            else{
                // console.log("Unknown record type", recordType);
                startPos += 1
            }
        }

        return response


    }

    handleClientHello(packet){
            
        this.clientRandom = packet.slice(14, 14 + 32);

        const clientHelloParsed = this.parseClientHello(packet);

        const serverHello = this.prepareServerHello(clientHelloParsed);
        this.serverRandom = serverHello.serverRandom;

        const serverHelloBody = serverHello.buffer;
        const serverHelloHeader = this.prepareRecordHeader(0x16, 0xfefd, 0, this.sequenceNumber++, serverHelloBody);

        const certificateBody = this.prepareCertificate();
        const certificateHeader = this.prepareRecordHeader(0x16, 0xfefd, 0, this.sequenceNumber++, certificateBody);

        const serverKeyExchangeBody = this.prepareServerKeyExchange({clientRandom: this.clientRandom, serverRandom: this.serverRandom});
        const serverKeyExchangeHeader = this.prepareRecordHeader(0x16, 0xfefd, 0, this.sequenceNumber++, serverKeyExchangeBody);

        const certificateRequestBody = this.prepareCertificateRequest();
        const certificateRequestHeader = this.prepareRecordHeader(0x16, 0xfefd, 0, this.sequenceNumber++, certificateRequestBody);

        const serverHelloDoneBody = this.prepareServerHelloDone();
        const serverHelloDoneHeader = this.prepareRecordHeader(0x16, 0xfefd, 0, this.sequenceNumber++, serverHelloDoneBody);


        this.handshakeMessagesSoFar.push(serverHelloBody, certificateBody, serverKeyExchangeBody, certificateRequestBody, serverHelloDoneBody);

        return Buffer.concat([
            serverHelloHeader, serverHelloBody,
            certificateHeader, certificateBody,
            serverKeyExchangeHeader, serverKeyExchangeBody,
            certificateRequestHeader, certificateRequestBody,
            serverHelloDoneHeader, serverHelloDoneBody
        ]);

    }

    _recordSummary(record){
        try{
            const handShakeType = record[0];
            let handShakeTypeStr;
            if(handShakeType == 1){
                handShakeTypeStr = "clientHello";
            }
            else if(handShakeType == 2){
                handShakeTypeStr = "serverHello";
            }
            else if(handShakeType == 11){
                handShakeTypeStr = "certificate";
            }
            else if(handShakeType == 12){
                handShakeTypeStr = "serverKeyExchange";
            }
            else if(handShakeType == 13){
                handShakeTypeStr = "certificateRequest";
            }
            else if(handShakeType == 14){
                handShakeTypeStr = "serverHelloDone";
            }
            else if(handShakeType == 15){
                handShakeTypeStr = "certificateVerify";
            }
            else if(handShakeType == 16){
                handShakeTypeStr = "clientKeyExchange";
            }
            else if(handShakeType == 20){
                handShakeTypeStr = "Finished";
            }
            else{
                handShakeTypeStr = "unknown";
            }

            let byteStr = "";
            for(let i = 0; i < 5; i++){
                byteStr += record[i].toString(16) + " ";
            }
            byteStr += "... ";
            // include last 5 bytes
            for(let i = record.length - 5; i < record.length; i++){
                byteStr += record[i].toString(16) + " ";
            }

            return `${handShakeTypeStr} (${record.length} bytes) | <${byteStr}>`;
        }
        catch(e){
            return "Error while summarizing record";
        }

    }

    prepareRecordHeader(contentType, version, epoch, sequenceNumber, packet){
        const recordHeaderView = new DataView(new ArrayBuffer(13));
        recordHeaderView.setUint8(0, contentType); // ContentType: Handshake
        recordHeaderView.setUint16(1, version); // Protocol version
        recordHeaderView.setUint16(3, epoch); // epoch
        recordHeaderView.setUint48(5, sequenceNumber); // Sequence number
        recordHeaderView.setUint16(11, packet.length); // Length

        return Buffer.from(recordHeaderView.buffer);

    }

    parseClientHello(clientHello){
        // return handshakeType, length, messageSequence, fragmentOffset, fragmentLength, protocolVersion, random, sessionID, cookieLength, cipherSuite, compressionMethod, extensions
        const view = new DataView(clientHello.buffer, clientHello.byteOffset, clientHello.byteLength);
        const pos = new Offset(0);

        const handshakeType = view.getUint8(pos.returnAndIncrement(1));
        // console.log('handshakeType:', handshakeType);
        
        const length = view.getUint24(pos.returnAndIncrement(3));
        
        const messageSequence = view.getUint16(pos.returnAndIncrement(2));
        
        const fragmentOffset = view.getUint24(pos.returnAndIncrement(3));
        
        const fragmentLength = view.getUint24(pos.returnAndIncrement(3));
        
        const protocolVersion = view.getUint16(pos.returnAndIncrement(2));
        
        const random = clientHello.slice(pos.returnAndIncrement(32), pos.position); 
        
        const sessionIDLength = clientHello[pos.returnAndIncrement(1)];
        
        const sessionID = sessionIDLength && clientHello.slice(pos.returnAndIncrement(sessionIDLength), pos.position);
        
        const cookieLength = clientHello[pos.returnAndIncrement(1)];
        
        const cookie = cookieLength && clientHello.slice(pos.returnAndIncrement(cookieLength), pos.position);
        
        const cipherSuitesLength = view.getUint16(pos.returnAndIncrement(2));
        
        const cipherSuites = clientHello.slice(pos.returnAndIncrement(cipherSuitesLength), pos.position).reduce((acc, val, i) => {
            if(i % 2 == 0){
                const suite = [];
                suite.push(val);
                acc.push(suite);
            }
            else{
                const suite = acc[acc.length - 1];
                suite.push(val);
            }
            return acc;
        }, []);
        
        const compressionMethodsLength = view.getUint8(pos.returnAndIncrement(1));
        
        const compressionMethods = clientHello.slice(pos.returnAndIncrement(compressionMethodsLength), pos.position);
        
        const extensionsLength = view.getUint16(pos.returnAndIncrement(2));
        // console.log('extensionsLength:', extensionsLength);
        
        const extensionsBlock = clientHello.slice(pos.returnAndIncrement(extensionsLength), pos.position);
        const extensions = []

        for(let extensionStartPos = 0; extensionStartPos < extensionsBlock.length;){
            const type = extensionsBlock[extensionStartPos] * 256 + extensionsBlock[extensionStartPos + 1];
            const length = extensionsBlock[extensionStartPos + 2] * 256 + extensionsBlock[extensionStartPos + 3];
            const value = extensionsBlock.slice(extensionStartPos + 4, extensionStartPos + 4 + length);

            extensionStartPos += 4 + length;

            extensions.push({type, length, value});
            //// console.log(`Extension type: ${type.toString(16)} | length: ${length} | value: ${getFormattedHexBuffer(value)}`);
        }

        //// console.log('extensions:', extensions);

        return {
            handshakeType, length, messageSequence, fragmentOffset, fragmentLength, protocolVersion, random, sessionID, cookie, cipherSuites, compressionMethods, extensions
        }
    }

    prepareServerHello(clientHelloParsed){

        const sessionIDLength = 32;

        const responseView = new DataView(new ArrayBuffer(150));
        const pos = new Offset(0);

        // DTLS Header
        // Handshake type: ServerHello
        responseView.setUint8(pos.returnAndIncrement(1), 0x02);

        // Length
        const protocolLengthPosition = pos.returnAndIncrement(3);
        responseView.setUint24(protocolLengthPosition, 0);

        // Message sequence, fragment offset, fragment length
        responseView.setUint16(pos.returnAndIncrement(2), 0);
        responseView.setUint24(pos.returnAndIncrement(3), 0);

        const fragmentLengthPosition = pos.returnAndIncrement(3);
        responseView.setUint24(fragmentLengthPosition, 0);

        const protocolStartPos = pos.position;

        // Protocol version
        responseView.setUint16(pos.returnAndIncrement(2), 0xfefd);

        // Random
        //crypto.randomFillSync(responseView.buffer, pos.returnAndIncrement(32), 32);
        const serverRandom = crypto.randomBytes(32);
        for(let i = 0; i < serverRandom.length; i++){
            responseView.setUint8(pos.returnAndIncrement(1), serverRandom[i]);
        }


        // Session ID Length
        responseView.setUint8(pos.returnAndIncrement(1), sessionIDLength);

        const sessionID = Buffer.alloc(sessionIDLength);
        crypto.randomFillSync(sessionID);
        for(let i = 0; i < sessionIDLength; i++){
            responseView.setUint8(pos.returnAndIncrement(1), sessionID[i]);
        }

        // Cipher suite: TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256
        responseView.setUint16(pos.returnAndIncrement(2), /*0x1301*/ /*0xc02f*/ 0xc02b);

        // Compression method: null
        responseView.setUint8(pos.returnAndIncrement(1), 0);

        // Extensions length: 28
        const extensionsLengthPosition = pos.position
        responseView.setUint16(pos.returnAndIncrement(2), 28);

        // Extensions: Type-Length-Value
        const extensionStartPos = pos.position

        clientHelloParsed.extensions.forEach(extension => {

            const type = extension.type;
            const length = extension.length;
            const value = extension.value;

            if (type == 0x0017 && false) {
                // Extension type: extended_master_secret, length: 0
                responseView.setUint16(pos.returnAndIncrement(2), 0x0017);
                responseView.setUint16(pos.returnAndIncrement(2), 0);
            } 
            else if (type == 0xff01) {
                // Extension type: renegotiation_info, length: 1, value: 0
                responseView.setUint16(pos.returnAndIncrement(2), 0xff01);
                responseView.setUint16(pos.returnAndIncrement(2), 1);
                responseView.setUint8(pos.returnAndIncrement(1), 0);
            } 
            else if (type == 0x000b) {
                // Extension type: ec_point_formats, length: 2, value: (ec_point_formats_length: 1, value: uncompressed)
                responseView.setUint16(pos.returnAndIncrement(2), 0x000b);
                responseView.setUint16(pos.returnAndIncrement(2), 2);
                responseView.setUint8(pos.returnAndIncrement(1), 1);
                responseView.setUint8(pos.returnAndIncrement(1), 0);
            } 
            else if (type == 0x000e) {
                // Extension type: use_srtp, length: 5, value: (srtp_protection_profiles_length: 2, value: SRTP_AES128_CM_HMAC_SHA1_80, mki_length: 0)
                responseView.setUint16(pos.returnAndIncrement(2), 0x000e);
                responseView.setUint16(pos.returnAndIncrement(2), 5);
                responseView.setUint16(pos.returnAndIncrement(2), 2);
                responseView.setUint16(pos.returnAndIncrement(2), this.srtpProfile);
                responseView.setUint8(pos.returnAndIncrement(1), 0);
            } else {
                // console.log(`Unknown extension type: ${type}`);
            }

        })

        // set extensions length
        responseView.setUint16(extensionsLengthPosition, pos.position - extensionStartPos)

        // set fragment length
        responseView.setUint24(fragmentLengthPosition, pos.position - protocolStartPos);

        // set protocol length
        responseView.setUint24(protocolLengthPosition, pos.position - protocolStartPos);

        const buffer = Buffer.from(responseView.buffer.slice(0, pos.position));

        return {
            serverRandom,
            buffer
        }

    }

    prepareCertificate(){

        const responseView = new DataView(new ArrayBuffer(1500));
        const pos = new Offset(0);

        // DTLS Header
        // Handshake type: Certificate
        responseView.setUint8(pos.returnAndIncrement(1), 0x0b);

        // Length: 3 bytes for certificates length, 3 bytes for certificate length, cert.length bytes for certificate
        responseView.setUint24(pos.returnAndIncrement(3), 3 + 3 + this.strippedCertBuffer.length); 
        // Message sequence, fragment offset, fragment length
        responseView.setUint16(pos.returnAndIncrement(2), 1);
        responseView.setUint24(pos.returnAndIncrement(3), 0);
        responseView.setUint24(pos.returnAndIncrement(3), 3 + 3 + this.strippedCertBuffer.length);

        // Certificates length: 3 bytes for certificate length, cert.length bytes for certificate
        responseView.setUint24(pos.returnAndIncrement(3), this.strippedCertBuffer.length + 3);

        // Certificates
        // certificate length
        responseView.setUint24(pos.returnAndIncrement(3), this.strippedCertBuffer.length);
        // certificate
        for(let i = 0; i < this.strippedCertBuffer.length; i++){
            responseView.setUint8(pos.returnAndIncrement(1), this.strippedCertBuffer[i]);
        }

        return Buffer.from(responseView.buffer.slice(0, pos.position));

    }

    prepareServerKeyExchange(params){

        const responseView = new DataView(new ArrayBuffer(1500));
        const pos = new Offset(0);

        // DTLS Header
        // Handshake type: ServerKeyExchange
        responseView.setUint8(pos.returnAndIncrement(1), 0x0c);

        // Length
        const protocolLengthPosition = pos.returnAndIncrement(3);
        responseView.setUint24(protocolLengthPosition, 0);

        // Message sequence, fragment offset
        responseView.setUint16(pos.returnAndIncrement(2), 2);
        responseView.setUint24(pos.returnAndIncrement(3), 0);

        // fragment length
        const fragmentLengthPosition = pos.returnAndIncrement(3);
        responseView.setUint24(fragmentLengthPosition, 0);

        const protocolStartPos = pos.position;

        // EC Diffie-Hellman parameters

        // Curve type: named_curve
        responseView.setUint8(pos.returnAndIncrement(1), 0x03);

        // Named curve: secp256r1
        responseView.setUint16(pos.returnAndIncrement(2), 0x0017);


        const ecdh = crypto.createECDH('prime256v1');
        ecdh.generateKeys();
        const publicKey = ecdh.getPublicKey(null, 'uncompressed');
        this.serverPrivateKey = ecdh.getPrivateKey();
        this.serverPublicKey = publicKey;

        // Public key length
        responseView.setUint8(pos.returnAndIncrement(1), publicKey.length);

        // Public key
        for(let i = 0; i < publicKey.length; i++){
            responseView.setUint8(pos.returnAndIncrement(1), publicKey[i]);
        }

        // signature algorithm: ecdsa_secp256r1_sha256 (0x0403 corresponds to ecdsa_secp256r1_sha256)
        responseView.setUint8(pos.returnAndIncrement(1), 0x04);
        responseView.setUint8(pos.returnAndIncrement(1), 0x03);

        //const hash = computeHash(publicKey);
        const dataForSigning = Buffer.concat([

            // clientRandom
            params.clientRandom,

            // serverRandom
            params.serverRandom,

            // Params
            Buffer.from([0x03, 0x00, 0x17]), // Curve Type and Named Curve (secp256r1)
            Buffer.from([publicKey.length]), // Length of the public key
            publicKey                       // The public key itself
        ]);
        const signature = this.computeSignatureWithPrivateKay(dataForSigning, this.key);
        //signature[0] = 0xff; // for fun heheeeeeeeeee-------------------------------------------------------------------------------------

        // signature length:
        responseView.setUint16(pos.returnAndIncrement(2), signature.length);

        // signature
        for(let i = 0; i < signature.length; i++){
            responseView.setUint8(pos.returnAndIncrement(1), signature[i]);
        }

        // console.log(`pos.position: ${pos.position} | protocolStartPos: ${protocolLengthPosition} | fragmentLengthPosition: ${fragmentLengthPosition}`)

        // protocol length
        // console.log("Protocol length", pos.position - protocolStartPos);
        responseView.setUint24(protocolLengthPosition, pos.position - protocolStartPos);

        // fragment length
        // console.log("Fragment length", pos.position - protocolStartPos);
        responseView.setUint24(fragmentLengthPosition, pos.position - protocolStartPos);

        return Buffer.from(responseView.buffer.slice(0, pos.position));

    }

    prepareCertificateRequest(){

        const responseView = new DataView(new ArrayBuffer(500));
        const pos = new Offset(0);

        // DTLS Header
        // Handshake type: CertificateRequest
        responseView.setUint8(pos.returnAndIncrement(1), 0x0d);

        // Length
        const protocolLengthPosition = pos.position;
        responseView.setUint24(pos.returnAndIncrement(3), 0);

        // Message sequence, fragment offset, fragment length
        responseView.setUint16(pos.returnAndIncrement(2), 3);
        responseView.setUint24(pos.returnAndIncrement(3), 0);

        const fragmentLengthPosition = pos.position;
        responseView.setUint24(pos.returnAndIncrement(3), 0);

        const fragementStartPos = pos.position;

        // Certificate types length
        responseView.setUint8(pos.returnAndIncrement(1), 3);

        // Certificate types
        responseView.setUint8(pos.returnAndIncrement(1), 1);
        responseView.setUint8(pos.returnAndIncrement(1), 2);
        responseView.setUint8(pos.returnAndIncrement(1), 64);

        const algorithms = [
            0x0403, 0x0503, 0x0603, 
            0x0804, 0x0805, 0x0806, 0x0807, 0x0808, 0x0809, 0x080a, 0x080b,
            0x0401, 0x0501, 0x0601,
            0x0301, 0x0302, 0x0303,
            0x0402, 0x0502, 0x0602,
        ];

        // Signature and hash algorithms length
        responseView.setUint16(pos.returnAndIncrement(2), algorithms.length * 2);

        // Signature and hash algorithms

        for(let i = 0; i < algorithms.length; i++){
            responseView.setUint16(pos.returnAndIncrement(2), algorithms[i]);
        }

        // Distinguished names length
        responseView.setUint16(pos.returnAndIncrement(2), 0);
        
        // fragment length

        const fragmentLength = pos.position - fragementStartPos;
        const protocolLength = fragmentLength; //protocolLengthPosition - pos.position;

        // console.log(`protocolLength: ${protocolLength} | fragmentLength: ${fragmentLength}`)
        responseView.setUint24(fragmentLengthPosition, fragmentLength);
        responseView.setUint24(protocolLengthPosition, protocolLength);

        return Buffer.from(responseView.buffer.slice(0, pos.position));

    }

    prepareServerHelloDone(){

        const responseView = new DataView(new ArrayBuffer(150));
        const pos = new Offset(0);

        // DTLS Header
        // Handshake type: ServerHelloDone
        responseView.setUint8(pos.returnAndIncrement(1), 0x0e);

        // Length
        responseView.setUint24(pos.returnAndIncrement(3), 0);

        // Message sequence, fragment offset, fragment length
        responseView.setUint16(pos.returnAndIncrement(2), 4);
        responseView.setUint24(pos.returnAndIncrement(3), 0);
        responseView.setUint24(pos.returnAndIncrement(3), 0);

        return Buffer.from(responseView.buffer.slice(0, pos.position));

    }

    prepareChangeCipherSpec(){

        // ChangeCipherSpec
        return Buffer.from([1]);


    }

    prepareFinished(){

        const handshakeHash = this.computeHashOfAllHandshakeMessages(this.handshakeMessagesSoFar);

        const verifyDataLength = 12;
        const verifyData = PRF(this.masterSecret, Buffer.from('server finished'), handshakeHash).slice(0, verifyDataLength);

        const key = this.symmetricKeys.serverWriteKey;

        // TODO: it has to be a sequence number, unique to each encrytion operation. For now we are randomly generating it
        const explicitNonce = Buffer.alloc(8);
        crypto.randomFillSync(explicitNonce);

        const nonce = Buffer.concat([
            this.symmetricKeys.serverWriteIV,
            explicitNonce
        ]);

        const plainText = Buffer.from([
            // handshake type
            0x14,

            // length
            ...this.returnNumberWithPaddedBytes(verifyDataLength, 3),

            // message sqeuence
            ...this.returnNumberWithPaddedBytes(5, 2),

            //fragment offset
            ...this.returnNumberWithPaddedBytes(0, 3),

            // fragment length
            ...this.returnNumberWithPaddedBytes(verifyDataLength, 3),

            // verifyData
            ...verifyData
        ])


        const seqNum = Buffer.from([
            //epoch
        0x00, 0x01, 

            // sequence number
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00
        ])

        const additionalData = Buffer.from([
            ...seqNum,

            // record type
            0x16,

            // version
            0xfe, 0xfd,

            // length
            ...this.returnNumberWithPaddedBytes(0x18, 2)
        ]);

        const cipher = crypto.createCipheriv('aes-128-gcm', key, nonce);
        cipher.setAAD(additionalData);
        const encrypted = cipher.update(plainText);
        cipher.final();
        const tag = cipher.getAuthTag();

        return Buffer.concat([explicitNonce, encrypted, tag]);
    }

    verifyClientFinished(header, payload){

        const nonceExplicitLength = 8; // 4 bytes implicit, 8 bytes explicit

        const key = this.symmetricKeys.clientWriteKey;
        const explicitNonce = payload.slice(0, nonceExplicitLength);

        const nonce = Buffer.concat([
            this.symmetricKeys.clientWriteIV,
            explicitNonce
        ]);

        const cipherText = payload.slice(nonceExplicitLength);

        const encryptedBlock = cipherText.slice(0, cipherText.length - 16);
        const tag = cipherText.slice(cipherText.length - 16);

        const seqNum = Buffer.from([
            ...this.returnNumberWithPaddedBytes(header.epoch, 2),
            ...this.returnNumberWithPaddedBytes(header.seqNo, 6)
        ])

        const additionalData = Buffer.from([
            ...seqNum,
            header.type,
            ...this.returnNumberWithPaddedBytes(header.version, 2),
            ...this.returnNumberWithPaddedBytes(encryptedBlock.length, 2)
        ]);
        //console.log('Client finished AAD:', additionalData.toString('hex'));

        //// console.log(`verifying clientFinished | key: ${key.toString('hex')} ${key.length} | iv: ${iv.toString('hex')} | encrypted: ${cipherText.toString('hex')} ${cipherText.length} | additionalData: ${additionalData.toString('hex')}`);
        
        // console.log('verifying clientFinished')
        // console.log('Key:', key.toString('hex'), key.length);
        // console.log('Implicit Nonce:', symmetricKeys.clientWriteIV.toString('hex'), symmetricKeys.clientWriteIV.length);

        // console.log('Payload:', payload.toString('hex'), payload.length);
        // console.log('   Explicit Nonce:', explicitNonce.toString('hex'), explicitNonce.length);
        // console.log('   CipherText:', cipherText.toString('hex'), cipherText.length);
        // console.log('      Encrypted:', encryptedBlock.toString('hex'), encryptedBlock.length);
        // console.log('      Tag:', tag.toString('hex'), tag.length);

        // console.log('Additional data:', additionalData.toString('hex'), additionalData.length);

        try{
            const decipher = crypto.createDecipheriv('aes-128-gcm', key, nonce);
            decipher.setAuthTag(tag);
            decipher.setAAD(additionalData);
            const decrypted = decipher.update(encryptedBlock);
            decipher.final();
            //console.log('Decrypted:', decrypted.toString('hex'));
            const decryptedStr = decrypted.toString('hex');

            let i = 0;
            while(1){

                const list = this.handshakeMessagesSoFar.slice(0, this.handshakeMessagesSoFar.length - i);

                if(list.length == 0){
                    // console.log('No handshake messages to verify');
                    break;
                }

                const handshakeHash = this.computeHashOfAllHandshakeMessages(list);
                // console.log(`Handshake hash ${i}`, handshakeHash.toString('hex'));
                const verifyData = PRF(this.masterSecret, Buffer.from('client finished'), handshakeHash, 12)
                // console.log('Verify data:', verifyData.toString('hex'));

                if(decryptedStr.includes(verifyData.toString('hex'))){
                    console.log('Correct verify data: ', verifyData.toString('hex'));
                    console.log('----------- Client finished verified! SUCCESS   -----------------');
                    break;
                }

                i++;
            }
            
            this.handshakeMessagesSoFar.push(decrypted);

        }catch(e){

            throw e
        }

    }

    computeSymmetricKeysFromMasterSecret(masterSecret, clientRandom, serverRandom){
        const seed = Buffer.concat([serverRandom, clientRandom]);

        const length = 
        //    (2 * 32) + // client_write_MAC_key + server_write_MAC_key
            (2 * 16) + // client_write_key + server_write_key
            (2 * 4); // client_write_IV + server_write_IV

        const keyBlock = PRF(
            masterSecret, 
            Buffer.from('key expansion'), 
            seed, 
            length
        );

        // console.log('Key block:', keyBlock.toString('hex'));

        const macKeyLength = 32;
        const keyLength = 16;
        const ivLength = 4;

        let start = 0, end = 0;

        // start = end, end = start + macKeyLength;
        // const clientWriteMACKey = keyBlock.slice(start, end);
        // start = end, end = start + macKeyLength;
        // const serverWriteMACKey = keyBlock.slice(start, end);
        start = end, end = start + keyLength;
        const clientWriteKey = keyBlock.slice(start, end);
        start = end, end = start + keyLength;
        const serverWriteKey = keyBlock.slice(start, end);
        start = end, end = start + ivLength;
        const clientWriteIV = keyBlock.slice(start, end);
        start = end, end = start + ivLength;
        const serverWriteIV = keyBlock.slice(start, end);


        return {clientWriteKey, serverWriteKey, clientWriteIV, serverWriteIV};
    }

    computeHashOfAllHandshakeMessages(messagesList){

        //console.log('Computing hash of all handshake messages');
        //console.log('Handshake messages so far:', messagesList.map(i => this._recordSummary(i)));

        const hash = crypto.createHash('sha256');
        for(let i = 0; i < messagesList.length; i++){
            hash.update(messagesList[i]);
        }

        return hash.digest()

    }

    computeSharedSecret(publicKey, privateKey){
        const ecdh = crypto.createECDH('prime256v1');
        ecdh.setPrivateKey(privateKey);
        return ecdh.computeSecret(publicKey);

    }

    computeMasterSecret(preMasterSecret, clientRandom, serverRandom){
        const seed = Buffer.concat([clientRandom, serverRandom]);
        return PRF(preMasterSecret, Buffer.from('master secret'), seed, 48);

    }

    computeSignatureWithPrivateKay(data, privateKey){
        const sign = crypto.createSign('sha256');
        sign.update(data);
        sign.end();
        const keyObject = crypto.createPrivateKey(privateKey);
        return sign.sign({
            key: keyObject,
            padding: crypto.constants.RSA_PKCS1_PADDING, // Adjust padding if necessary
            dsaEncoding: 'der' // DER encoding is typically used in TLS
        });

    }


    returnNumberWithPaddedBytes(number, bytes){
        const buffer = Buffer.alloc(bytes);
        buffer.writeUIntBE(number, 0, bytes);
        return buffer;
    }

    writeToKeyLogFile(clientRandom, masterSecret){
        if (!fs.existsSync(globalThis.serverConfig.keyLogOutputPath)) {
            // Create directory if it doesn't exist
            const dir = globalThis.serverConfig.keyLogOutputPath.substring(0, globalThis.serverConfig.keyLogOutputPath.lastIndexOf('/'));
            if (dir && !fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
        }
        const keyLogFile = fs.createWriteStream('keylog.log', {flags: 'a'});
        keyLogFile.write(`CLIENT_RANDOM ${clientRandom.toString('hex')} ${masterSecret.toString('hex')}\n`);
        keyLogFile.end();
    }

}

module.exports = {
    getFingerprintOfCertificate,
    initializeDTLS,
    DTLSContext
};

