
const {ntpToTimeMs} = require('../helpers/common_helper');

/**
 * This class takes care of processing RTP packets.
 * Actual writing on the wire and actual listening from the wire are outside the scope of this class.
 */
class RTPContext{

    static #MAX_DROPOUT = 3000;
    static #MAX_MISORDER = 100;
    static #MIN_SEQUENTIAL = 2;
    static #RTP_SEQ_MOD = 1 << 16 

    #ssrcStats = {};
    #knownRTPPayloadTypes = new Set([96, 97]);

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
    
        const payloadType = packet[1] & 0b01111111;
    
    
        //console.log(`${currentTime}: ${type} - Ver: ${version} | Padding: ${padding} | Ext: ${extension} | CSRCCount: ${csrcCount} | Mbit: ${marker} | PT: ${payloadType} | SeqNo: ${sequenceNumber} | time: ${timestamp} | SSRC: ${ssrc}`);
    
        if(payloadType == 96){
            this.#handleRTP(packet);

        }
        else{
            this.handleRTCP(packet);
        }
    }

    #validateRTPHeader(rtpPacket){
        const version = rtpPacket[0] >> 6;
        const payloadType = rtpPacket[1] & 0b01111111;

        if(version != 2){
            console.error('Invalid version');
            return false;
        }

        if(!this.#knownRTPPayloadTypes.has(payloadType)){
            console.error('Unknown payload type');
            return false;
        }

        else return true;
        
    }

    #initSequenceNo(ssrc, currentSeqNo){
        this.#ssrcStats[ssrc] = {
            baseSeqNo: currentSeqNo,
            maxSeqNo: currentSeqNo,
            lastBadSeqNo: RTPContext.#RTP_SEQ_MOD + 1,
            cycles: 0,
            packetsReceived: 0,

            // TODO: rename it later
            received_prior: 0,
            expected_prior: 0,

        }
    }

    #updateSequenceNo(ssrc, currentSeqNo){
        const seqNoDelta = currentSeqNo - this.#ssrcStats[ssrc].maxSeqNo;
        
        const ssrcStats = this.#ssrcStats[ssrc];

        if(ssrcStats.probationPacketsRemaining > 0){
            if(currentSeqNo == ssrcStats.maxSeqNo + 1){
                ssrcStats.probationPacketsRemaining--;
                ssrcStats.maxSeqNo = currentSeqNo;

                if(ssrcStats.probationPacketsRemaining == 0){
                    this.#initSequenceNo(ssrc, currentSeqNo);
                    ssrcStats.packetsReceived += 1;
                    return true;
                }
            }
            else{

                // reset probation, but also consider current packet starting a new sequence. That's why the -1;
                ssrcStats.probationPacketsRemaining = RTPContext.#MIN_SEQUENTIAL - 1;
                ssrcStats.maxSeqNo = currentSeqNo;
            }
            return false;
        }
        else if(seqNoDelta < RTPContext.#MAX_DROPOUT){
            if(currentSeqNo < ssrcStats.maxSeqNo){
                ssrcStats.cycles += RTPContext.#RTP_SEQ_MOD;
            }
            ssrcStats.maxSeqNo = currentSeqNo;
        }
        else if(seqNoDelta <= RTPContext.#RTP_SEQ_MOD - RTPContext.#MAX_MISORDER){
            if(currentSeqNo == ssrcStats.lastBadSeqNo){
                this.#initSequenceNo(ssrc, currentSeqNo);
            }
            else{
                ssrcStats.lastBadSeqNo = (currentSeqNo + 1) & (RTPContext.#RTP_SEQ_MOD - 1);
                return false;
            }
        }
        else{
            console.log('out of order')
        }

        ssrcStats.packetsReceived += 1;
        return true;

        
        
    }

    #handleRTP(rtpPacket){

        const ssrc = rtpPacket.readUInt32BE(8);
        const seqNo = rtpPacket.readUInt16BE(2);
        

        if(!this.#ssrcStats[ssrc]){
            this.#initSequenceNo(ssrc, seqNo);
            this.#ssrcStats[ssrc].maxSeqNo = seqNo - 1;
            this.#ssrcStats[ssrc].probationPacketsRemaining = RTPContext.#MIN_SEQUENTIAL
        }
        else{
            this.#updateSequenceNo(ssrc, seqNo);
        }
        

        // validate RTP header
        if(!this.#validateRTPHeader(rtpPacket)){
            console.error('Invalid RTP header');
            return;
        }

        //console.log(JSON.stringify(this.#ssrcStats[ssrc]))

        this.rtpPacketReadyForApplicationCallback(rtpPacket);
    }

    handleRTCP(rtcpPacket){
        const padding = (rtcpPacket[0] >> 5) & 0b1;
        const rrc = rtcpPacket[0] & 0b00011111;
        
        const payloadType = rtcpPacket[1];

        if(payloadType == 200){
            
            const ssrc = rtcpPacket.readUInt32BE(4);

            const length = rtcpPacket.readUInt16BE(2);
            const ntpTimestampMSB = rtcpPacket.readUInt32BE(8);
            const ntpTimestampLSB = rtcpPacket.readUInt32BE(12);

            const rtpTimestamp = rtcpPacket.readUInt32BE(16);
            const packetCount = rtcpPacket.readUInt32BE(20);
            const octetCount = rtcpPacket.readUInt32BE(24);
            //console.log(`SR (pkt len: ${rtcpPacket.length}) Padding: ${padding} | RRC: ${rrc} | Length: ${length} | SSRC: ${ssrc} | NTP: ${(new Date(ntpToTimeMs(ntpTimestampMSB, ntpTimestampLSB))).toLocaleString()} | RTP TS: ${rtpTimestamp} | Packet Count: ${packetCount} | Octet Count: ${octetCount}`);
            //console.log('got SR, sending Rreceiver Report');

            this.#ssrcStats[ssrc].lastSR = {
                timestamp: performance.now(),
                ntpTimestampMSB,
                ntpTimestampLSB,
                rtpTimestamp,
                packetCount,
                octetCount,
            }

            if(!this.#ssrcStats[ssrc]){
                this.#ssrcStats[ssrc] = {}
            }

            const receiverReport = this.generateReceiverReport(ssrc);
            this.sendPacketToRemote(receiverReport);

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

        const ssrcStats = this.#ssrcStats[ssrc]
        const extendedSeqNo = ssrcStats.cycles + ssrcStats.maxSeqNo;
        const extendedSeqNoBuffer = Buffer.alloc(4);
        extendedSeqNoBuffer.writeUInt32BE(extendedSeqNo, 0);

        const ntpMSBLast16Bits = (ssrcStats.lastSR.ntpTimestampMSB & 0x0000FFFF)
        const ntpLSBFirst16Bits = (ssrcStats.lastSR.ntpTimestampLSB >> 16) & 0xFFFF;

        //console.log(ssrcStats.lastSR.ntpTimestampMSB.toString(16), ssrcStats.lastSR.ntpTimestampLSB.toString(16))
        //console.log(ntpMSBLast16Bits.toString(16), ntpLSBFirst16Bits.toString(16))

        const ntpMiddle32Bits = Buffer.alloc(4);
        ntpMiddle32Bits.writeUInt16BE(ntpMSBLast16Bits, 0);
        ntpMiddle32Bits.writeUInt16BE(ntpLSBFirst16Bits, 2);
        

        const dlsrMs = performance.now() - ssrcStats.lastSR.timestamp;
        const dlsr = Math.floor(dlsrMs * 65.536); // convert to 1/65536 seconds
        //console.log('generating RR for SSRC ', ssrc, 'dlsr:', dlsr, 'lastSR:', ssrcStats.lastSR)

        const dlsrBuffer = Buffer.alloc(4);
        dlsrBuffer.writeUInt32BE(dlsr, 0);

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
            0,

            // cumulative no of pkts lost
            ...[0, 0, 0],

            // extended seq no
            ...extendedSeqNoBuffer,

            // jitter
            ...[0, 0, 0, 0],

            // last SR
            ...ntpMiddle32Bits,

            // delay since last SR
            ...dlsrBuffer

            
        ]

        const buffer = Buffer.from(temp);
        const length = buffer.length / 4 - 1;
        buffer.writeUInt16BE(length, 2);

        return buffer;
    }

    sendPacketToRemote(rtpPacket){
        //console.log(`Encrypted.. Sending ${type} packet to remote`);
        this.sendPacketToRemoteCallback(rtpPacket);
    }

}


        

module.exports = {
    RTPContext
}