
const os = require('os');
const dgram = require('node:dgram');
const { calculateSHA1, calculateCRC32, generateRandomString } = require('../helpers/crypto_helper.js');


const localAddress = os.networkInterfaces().en0.find(e => e.family === 'IPv4').address;

class ICEContext{

    udpSocket = dgram.createSocket('udp4');
    selfUfrag = generateRandomString(4);
    selfPwd = generateRandomString(24);
    remoteUfrag = null;
    remotePwd = null;
    onPacketCB = null;
    remote = null;

    constructor({onPacketReceived}){

        this.onPacketCB = onPacketReceived;

        this.udpSocket.bind();

        
        this.udpSocket.on('listening', () => {
            const address = this.udpSocket.address();
            console.log(`Peer UDP socket listening on ${address.address}:${address.port}`);
        });

        this.udpSocket.on('message', this.handlePacket.bind(this));
    }

    getCandidates(){
        const address = this.udpSocket.address();
        return [`a=candidate:121418589 1 udp 2122260224 ${localAddress} ${address.port} typ host generation 0 network-id 1 network-cost 10\r\n`]
    }

    setRemoteUfragAndPassword(remoteUfrag, remotePwd){
        this.remoteUfrag = remoteUfrag;
        this.remotePwd = remotePwd;
    }

    sendPacket(packet, remote){
        if(!remote){

            if(!this.remote){
                console.log("Remote not set. Ignoring packet", packet);
                return
            }

            remote = this.remote;
        }
        this.udpSocket.send(packet, remote.port, remote.address);
    }

    handlePacket(packet, remote){
        // if is a STUN packet
        if(packet.at(0) == 0 && packet.at(1) == 1){
            const bindingResponse = this.handleSTUNBindingRequest(packet, remote.address, remote.port, remote.family, this.selfPwd);
            this.sendPacket(bindingResponse, remote);
            this.remote = remote;
        }
        // should be DTLS or SRTP. Pass it to the appropriate handler
        else{
            this.onPacketCB(packet, remote);
        }
    }

    handleSTUNBindingRequest(packet, srcaddr, srcport, ipFamily, selfPwd){
        //console.log("STUN BINDING REQUEST", packet.length);
        const view = new DataView(packet.buffer);
    
        // const stunMethod = view.getUint8(0);
        // const stunClass = view.getUint8(1);
        // const messageLength = view.getUint16(2);
        // const magicCookie = view.getUint32(4);
    
    
        // next 12 bytes is transactionID
        const transactionID = packet.slice(8, 20);
        //console.log('transaction id:',  transactionID.reduce((acc, curr) => acc + curr.toString(16), ''))
    
        let attributeCount = 0;
        let offset = 20;
        while(false){
    
            let attrType = view.getUint16(offset);
            let attrLength = view.getUint16(offset + 2);
            const totalAttrLength = 2 + 2 + attrLength;
            const padding = (4 - (totalAttrLength % 4)) % 4
    
            //console.group("New Attribute:", "attrType", attrType, "attrLength", attrLength, "padding", padding, "offset", offset);
            attributeCount++;
            if(attrType == 1){
                let family = view.getUint8(offset + 4);
                let port = view.getUint16(offset + 5);
                let addr = view.getUint32(offset + 9);
                //console.log(`MAPPED ADDRESS:   family: ${family} port: ${port} addr: ${addr}`);
                
    
                const totalAttrLength = 2 + 2 + attrLength;
                const padding = 4 - (totalAttrLength % 4)
                offset += totalAttrLength + padding;
    
            }
            else if(attrType == 2){
                
                let family = view.getUint8(offset + 4);
                let port = view.getUint16(offset + 5);
                let addr = view.getUint32(offset + 9);
                //console.log(`RESPONSE ADDRESS:   family: ${family} port: ${port} addr: ${addr}`)
            }
            else if(attrType == 3){
                //console.log("CHANGE REQUEST");
            }
            else if(attrType == 4){
                
                let family = view.getUint8(offset + 4);
                let port = view.getUint16(offset + 5);
                let addr = view.getUint32(offset + 9);
                //console.log("SOURCE ADDRESS:   family: ", family, " port: ", port, " addr: ", addr);
            }
            else if(attrType == 5){
                
                let family = view.getUint8(offset + 4);
                let port = view.getUint16(offset + 5);
                let addr = view.getUint32(offset + 9);
                //console.log("CHANGED ADDRESS:   family: ", family, " port: ", port, " addr: ", addr);
            }
            else if(attrType == 6){
                //console.log("USERNAME");
            }
            else if(attrType == 7){
                //console.log("PASSWORD");
            }
            else if(attrType == 8){
                //console.log("MESSAGE INTEGRITY");
            }
            else if(attrType == 9){
                //console.log("ERROR CODE");
            }
            else{
                //console.log("UNKNOWN ATTRIBUTE", attrType);
            }
            offset += totalAttrLength + padding;
            //console.groupEnd();
            
            if(offset >= packet.buffer.byteLength){
                break;
            }
            
            
        }
        //console.log("attributecount", attributeCount);
        return this.prepareSTUNBindingResponse(transactionID, srcaddr, srcport, ipFamily, selfPwd);
    
    }
    
    prepareSTUNBindingResponse(transactionID, srcaddr, srcport, ipFamily, selfPwd){
    
        if(!selfPwd){
            console.log("Self password not set, ignoring STUN request");
            return;
        }
    
        const headerByteLength = 20;
        const attributesByteLength = 12 + 24 + 8
    
        const responsePacket = new Uint8Array(headerByteLength + attributesByteLength);
        const responseView = new DataView(responsePacket.buffer);
    
        // STUN Header
        // STUN response type ID
        responseView.setUint16(0, 0x0101);
    
        // Message length (of attributes, excluding header)
        responseView.setUint16(2, 12);
    
        // Magic cookie!
        responseView.setUint32(4, 0x2112A442);
    
        // Transaction ID
        responsePacket.set(transactionID, 8);
         
        
        
        // Attribute: XOR-MAPPED-ADDRESS
        // Attribute Type 
        responseView.setUint16(20, 0x0020);
    
        // Attribute Length
        responseView.setUint16(22, 0x0008);
    
        //Attribute Value
        // Reserved Byte
        responseView.setUint8(24, 0);
    
        // IP Family (IPv4)
        const ipFamilyByte = ipFamily == 'IPv4' ? 0x01 : 0x02;
        responseView.setUint8(25, ipFamilyByte);
    
        // XORed Port
        const xorPort = srcport ^ 0x2112;
        responseView.setUint16(26, xorPort);
    
        // XORed IP
        const octets = srcaddr.split('.').map(Number);
        const ipNumeric = (octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3];
        const xorIp = ipNumeric ^ 0x2112A442;
        responseView.setUint32(28, xorIp);
    
        // set responsePacketLength = Total length of attributes - length of attributes that come after MESSAGE-INTEGRITY
        responseView.setUint16(2, attributesByteLength - 8);
    
        // ATTRIBUTE - MESSAGE-INTEGRITY
        // Attribute Type
        responseView.setUint16(32, 0x0008);
        
        // Attribute Length
        responseView.setUint16(34, 0x0014);
    
        // Attribute value
        const sha1 = calculateSHA1(Buffer.from(responsePacket.slice(0, 32)), selfPwd)
        responsePacket.set(sha1, 36);
    
        // set actual message length
        responseView.setUint16(2, attributesByteLength);
    
        // ATTRIBUTE - FINGERPRINT
        // Attribute type
        responseView.setUint16(56, 0x8028);
    
        // Attribute Length
        responseView.setUint16(58, 0x0004);
    
        // Attribute Value
        const crc32 = calculateCRC32(responsePacket.slice(0, 56));
        const fingerprint = crc32 ^ 0x5354554e;
        //       console.log('crc32', crc32, "fingerprint", fingerprint);
        responseView.setUint32(60, fingerprint);
        
        return responsePacket;
    }
}

module.exports = {
    ICEContext
};