
const {ntpToTimeMs} = require('../helpers/common_helper');

/**
 * This class takes care of processing RTP packets.
 * Actual writing on the wire and actual listening from the wire are outside the scope of this class.
 */
class RTPContext{

    /**
     * 
     * @param {Object} Params
     * @param {Function} Params.onPacketReadyToSend - Callback that will be called when a packet needs to be sent to the remote peer.
     * For every call of `sendPacketToRemote`, the SRTPContext will call `onPacketReadyToSend` with the encrypted SRTP packet
     * 
     * @param {Function} Params.onRTPPacketReadyForApplication - Callback that will be called when an RTP packet is ready to be used by the application
     * For every call of `handlePacketFromRemote`, the SRTPContext will call `onRTPPacketReadyForApplication` with the decrypted RTP packet
     * 
     */
    constructor({onPacketReadyToSend, onRTPPacketReadyForApplication}){
        this.sendPacketToRemoteCallback = onPacketReadyToSend;
        this.rtpPacketReadyForApplicationCallback = onRTPPacketReadyForApplication;
    }
    
    handlePacketFromRemote(packet, remote){

        const version = packet[0] >> 6;
        if(version != 2){
            console.error('Invalid version');
            return;
        }
    
        const byte2 = packet[1];
        const payloadType = byte2 & 0b01111111;
    
    
        //console.log(`${currentTime}: ${type} - Ver: ${version} | Padding: ${padding} | Ext: ${extension} | CSRCCount: ${csrcCount} | Mbit: ${marker} | PT: ${payloadType} | SeqNo: ${sequenceNumber} | time: ${timestamp} | SSRC: ${ssrc}`);
    
        if(payloadType == 96){
            this.#handleRTP(packet);

        }
        else{
            this.handleRTCP(packet);
        }
    }

    #handleRTP(rtpPacket){
        this.rtpPacketReadyForApplicationCallback(rtpPacket);
    }

    handleRTCP(rtcpPacket){
        const padding = (rtcpPacket[0] >> 5) & 0b1;
        const rrc = rtcpPacket[0] & 0b00011111;
        
        const payloadType = rtcpPacket[1];

        if(payloadType == 200){
            const length = rtcpPacket.readUInt16BE(2);
            const ssrc = rtcpPacket.readUInt32BE(4);

            const ntpTimestampMSB = rtcpPacket.readUInt32BE(8);
            const ntpTimestampLSB = rtcpPacket.readUInt32BE(12);

            const rtpTimestamp = rtcpPacket.readUInt32BE(16);
            const packetCount = rtcpPacket.readUInt32BE(20);
            const octetCount = rtcpPacket.readUInt32BE(24);
            //console.log(`SR (pkt len: ${rtcpPacket.length}) Padding: ${padding} | RRC: ${rrc} | Length: ${length} | SSRC: ${ssrc} | NTP: ${(new Date(ntpToTimeMs(ntpTimestampMSB, ntpTimestampLSB))).toLocaleString()} | RTP TS: ${rtpTimestamp} | Packet Count: ${packetCount} | Octet Count: ${octetCount}`);
            //console.log('got SR, sending Rreceiver Report');

        }
        else if (payloadType == 201){
            const length = rtcpPacket.readUInt16BE(2);
            const ssrc = rtcpPacket.readUInt32BE(4);
            //console.log(`RR (pkt len: ${rtcpPacket.length}) Padding: ${padding} | RRC: ${rrc} | Length: ${length} | SSRC: ${ssrc}`);

        }
        else{
            this.rtpPacketReadyForApplicationCallback(rtcpPacket);
        }
    }

    generateReceiverReport(ssrc){

        const ssrcBuffer = Buffer.alloc(4);
        ssrcBuffer.writeUInt32BE(ssrc, 0);

        const temp = [
            // version : 2, padding : 0, report count: 1 
            2 << 6 | 0 << 5 | 1,

            // receiver report
            201,

            // length (0 for now)
            0, 0,
            
            // sender ssrc
            ...[0, 0, 0, 1],


            // report block
            // source ssrc
            ...ssrcBuffer,

            // fraction lost


            
        ]
    }

    sendPacketToRemote(rtpPacket){
        //console.log(`Encrypted.. Sending ${type} packet to remote`);
        this.sendPacketToRemoteCallback(rtpPacket);
    }

}


        

module.exports = {
    RTPContext
}