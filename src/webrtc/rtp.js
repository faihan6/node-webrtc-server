
const {ntpToTimeMs, setUInt24, CustomEventTarget} = require('../helpers/common_helper');

/**
 * This class takes care of processing RTP packets.
 * Actual writing on the wire and actual listening from the wire are outside the scope of this class.
 */
class RTPContext extends CustomEventTarget{

    static #MAX_DROPOUT = 3000;
    static #MAX_MISORDER = 100;
    static #MIN_SEQUENTIAL = 2;
    static #RTP_SEQ_MOD = 1 << 16 

    #ssrcStats = {};

    /**
     * 
     * @param {Object} Params
     * @param {Function} Params.onPacketReadyToSend - Callback that will be called when a packet needs to be sent to the remote peer.
     * For every call of `handleOutgoingPacketToClient`, the SRTPContext will call `onPacketReadyToSend` with the encrypted SRTP packet
     * 
     * @param {Function} Params.onRTPPacketReadyForApplication - Callback that will be called when an RTP packet is ready to be used by the application
     * For every call of `handlePacketFromRemote`, the SRTPContext will call `onRTPPacketReadyForApplication` with the decrypted RTP packet
     * 
     */
    constructor(){
        super();
    }

    #validateRTPHeader(rtpPacket){
        const version = rtpPacket[0] >> 6;
        const payloadType = rtpPacket[1] & 0b01111111;

        if(version != 2){
            console.error('Invalid version');
            return false;
        }

        else return true;
        
    }

    #initSequenceNo(ssrc, currentSeqNo){

        if(!this.#ssrcStats[ssrc]){
            this.#ssrcStats[ssrc] = {}
        }

        this.#ssrcStats[ssrc].baseSeqNo = currentSeqNo;
        this.#ssrcStats[ssrc].maxSeqNo = currentSeqNo;
        this.#ssrcStats[ssrc].lastBadSeqNo = RTPContext.#RTP_SEQ_MOD + 1;
        this.#ssrcStats[ssrc].cycles = 0;
        this.#ssrcStats[ssrc].packetsReceived = 0;

        // TODO: rename it later
        this.#ssrcStats[ssrc].received_prior = 0;
        this.#ssrcStats[ssrc].expected_prior = 0;

        //console.log('Initialized sequence number for SSRC:', ssrc, currentSeqNo);

        
    }

    #updateSequenceNo(ssrc, currentSeqNo){
        const seqNoDelta = currentSeqNo - this.#ssrcStats[ssrc].maxSeqNo;
        
        const ssrcStats = this.#ssrcStats[ssrc];

        if(ssrcStats.probationPacketsRemaining > 0){
            if(currentSeqNo == ssrcStats.maxSeqNo + 1){
                ssrcStats.probationPacketsRemaining--;
                ssrcStats.maxSeqNo = currentSeqNo;

                //TODO: packetsReceived is not being incremented when in probation. 
                // So it will be zero and those packets are considered as lost when sending RR 
                // This is what the pseudocode in RFC 3550 looked like. Check if it is fine.

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
            console.log('out of order', ssrc, currentSeqNo)
        }

        ssrcStats.packetsReceived += 1;
        return true;

        
        
    }

    #updateJitter(ssrc, departureRTPTimestamp){
        const arrivalWallclockTime = performance.now();

        if(this.#ssrcStats[ssrc].lastArrivalWallclockTime && this.#ssrcStats[ssrc].lastDepartureRTPTimestamp){
            const arrivalTimeDiffMS = arrivalWallclockTime - this.#ssrcStats[ssrc].lastArrivalWallclockTime;
            const arrivalTimeDiffRTPUnits = (arrivalTimeDiffMS / 1000) * this.#ssrcStats[ssrc].clockRate;

            const departureTimeDiffRTPUnits = departureRTPTimestamp - this.#ssrcStats[ssrc].lastDepartureRTPTimestamp;

            const currentJitter = Math.abs(arrivalTimeDiffRTPUnits - departureTimeDiffRTPUnits);

            if(!this.#ssrcStats[ssrc].jitter){
                this.#ssrcStats[ssrc].jitter = currentJitter;
            }
            else{
                this.#ssrcStats[ssrc].jitter += (currentJitter - this.#ssrcStats[ssrc].jitter) / 16;
            }
        }

        this.#ssrcStats[ssrc].lastArrivalWallclockTime = arrivalWallclockTime;
        this.#ssrcStats[ssrc].lastDepartureRTPTimestamp = departureRTPTimestamp;
    }

    /**
     * 
     * @typedef {Object} HeaderExtensionsInfo
     * @property {Boolean} areExtensionsPresent - Boolean indicating if header extensions are present.
     * @property {Number} extensionsBufferLength - Length of the buffer containing the header extensions. Includes the 0xBEDE header, the extensions and the padding
     */
    
    /** 
     * @param {*} rtpPacket 
     * @returns {HeaderExtensionsInfo} Information about the header extensions
     */
    static parseHeaderExtensions(rtpPacket){
        // parse header extensions
        const areExtensionsPresent = rtpPacket[0] & 0b00010000;

        /**
         * includes the 0xBEDE header, the extensions and the padding
         */
        let extensionsBufferLength = 0;

        if(areExtensionsPresent){
            const isOneByteHeaderMode = rtpPacket.readUInt16BE(12) == 0xBEDE;
            const extensionLength = rtpPacket.readUInt16BE(14);

            let start = 16;
            for(let i = 0; i < extensionLength; i++){
                const extId = (rtpPacket[start] & 0b11110000) >> 4;
                const extLength = (rtpPacket[start] & 0b00001111) + 1;
                const extValue = rtpPacket.slice(start + 1, start + 1 + extLength);
                console.log(rtpPacket[start], 'Extension:', extId, extLength, extValue);

                start += 1 + extLength;
            }
            
            // padding
            const padding = 4 - (start % 4);

            extensionsBufferLength = (start + padding) - 12;

            console.log(rtpPacket.readUInt16BE(2), 'No of Extensions:', extensionLength, 'One byte header mode:', isOneByteHeaderMode, 'Extensions Buffer Length:', extensionsBufferLength, 'start', start, 'Padding:', padding);
            
        }

        
        return {
            areExtensionsPresent,
            extensionsBufferLength
        }
    }

    handleRTPFromClient(rtpPacket){

        const ssrc = rtpPacket.readUInt32BE(8);
        const seqNo = rtpPacket.readUInt16BE(2);

        // handle sequence number
        if(!this.#ssrcStats[ssrc] || !this.#ssrcStats[ssrc].baseSeqNo){
            console.log('First packet for SSRC:', ssrc);
            this.#initSequenceNo(ssrc, seqNo);
            //this.#ssrcStats[ssrc].maxSeqNo = seqNo - 1;
            this.#ssrcStats[ssrc].probationPacketsRemaining = RTPContext.#MIN_SEQUENTIAL

            this.#ssrcStats[ssrc].clockRate = 90000;
        }
        else{
            this.#updateSequenceNo(ssrc, seqNo);
        }
        

        // validate RTP header
        if(!this.#validateRTPHeader(rtpPacket)){
            console.error('Invalid RTP header');
            return;
        }

        // update inter-arrival jitter
        const departureRTPTimestamp = rtpPacket.readUInt32BE(4);
        this.#updateJitter(ssrc, departureRTPTimestamp);

    }

    handleFeedbackFromClient(rtcpPacket){
        const padding = (rtcpPacket[0] >> 5) & 0b1;
        const rrc = rtcpPacket[0] & 0b00011111;
        
        const packetType = rtcpPacket[1];
        console.log('fb from client', packetType)

        if(packetType == 200){
            
            const ssrc = rtcpPacket.readUInt32BE(4);

            const length = rtcpPacket.readUInt16BE(2);
            const ntpTimestampMSB = rtcpPacket.readUInt32BE(8);
            const ntpTimestampLSB = rtcpPacket.readUInt32BE(12);

            const rtpTimestamp = rtcpPacket.readUInt32BE(16);
            const packetCount = rtcpPacket.readUInt32BE(20);
            const octetCount = rtcpPacket.readUInt32BE(24);
            //console.log(`NTP: ${(new Date(ntpToTimeMs(ntpTimestampMSB, ntpTimestampLSB))).toLocaleString()} | RTP TS: ${rtpTimestamp}`);

            if(!this.#ssrcStats[ssrc]){
                console.log('First RTCP packet for SSRC:', ssrc);
                this.#ssrcStats[ssrc] = {}
            }
            
            this.#ssrcStats[ssrc].lastSR = {
                timestamp: performance.now(),
                ntpTimestampMSB,
                ntpTimestampLSB,
                rtpTimestamp,
                packetCount,
                octetCount,
            }

            const receiverReport = this.#generateReceiverReport(ssrc);

            this.dispatchEvent('send_fb_i_to_remote', receiverReport);

        }
    }

    #generateReceiverReport(ssrc){

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

        /* 
            When calculating RR when only one packet has arrived,
            extendedSeqNo (a.k.a the seq no of last packet) and base sequence no will be the same.
            Calcualating expected packets with extendedSeqNo - baseSeqNo would give zero in this case
            But, the no of packets received so far is one.
            So, when calculating expectedPackets, always add 1 to include the first packet as well.
        */
        const expectedPackets = extendedSeqNo - ssrcStats.baseSeqNo + 1
        const lostPackets = expectedPackets - ssrcStats.packetsReceived;

        //console.log('Expected:', expectedPackets, 'Received:', ssrcStats.packetsReceived, 'Lost:', lostPackets);

        const lostPacketsBuffer = Buffer.alloc(3);
        setUInt24(lostPacketsBuffer, 0, lostPackets);

        let fractionLost = 0;
        if(ssrcStats.received_prior && ssrcStats.expected_prior){
            const expectedPacketsSinceLastReport = expectedPackets - ssrcStats.expected_prior;
            const receivedPacketsSinceLastReport = ssrcStats.packetsReceived - ssrcStats.received_prior;
            const lostPacketsSinceLastReport = expectedPacketsSinceLastReport - receivedPacketsSinceLastReport;

            
            if(lostPacketsSinceLastReport == 0 || expectedPacketsSinceLastReport == 0){
                fractionLost = 0;
            }
            else{
                fractionLost = Math.floor((lostPacketsSinceLastReport * 256) / expectedPacketsSinceLastReport);
                if(fractionLost < 0){
                    fractionLost = 0;
                }
            }
            
        }

        ssrcStats.received_prior = ssrcStats.packetsReceived;
        ssrcStats.expected_prior = expectedPackets;

        const jitter = Math.floor(ssrcStats.jitter);
        const jitterAsBuffer = Buffer.alloc(4); // jitter represented as a buffer, not the jitter buffer used to rearrange packets
        jitterAsBuffer.writeUInt32BE(jitter, 0);
        
        console.log(`SSRC: ${ssrc} | Expected: ${expectedPackets} | Received: ${ssrcStats.packetsReceived} | Lost: ${lostPackets} | Fraction Lost: ${fractionLost} | Jitter: ${jitter} | Last SR: ${ssrcStats.lastSR.rtpTimestamp} | DLSR ms: ${dlsrMs}`);

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
            fractionLost,

            // cumulative no of pkts lost
            ...lostPacketsBuffer,

            // extended seq no
            ...extendedSeqNoBuffer,

            // jitter
            ...jitterAsBuffer,

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

    handleOutgoingPacketToClient(packet, sourceContext){
        

        //this.dispatchEvent('send_rtp_o_to_remote', packet);
    }

    handleRTPToRemote(packet, sourceContext){
        
        this.#processRTPBeforeSending(packet, sourceContext);
        this.dispatchEvent('send_rtp_o_to_remote', packet);
        
    }

    handleFeedbackToRemote(packet){
        this.dispatchEvent('send_fb_i_to_remote', packet);
    }

    #processRTPBeforeSending(rtpPacket, sourceContext){

        const ssrc = rtpPacket.readUInt32BE(8);
        if(!this.#ssrcStats[ssrc]){
            this.#ssrcStats[ssrc] = {
                packetsSent: 0,
                payloadBytesSent: 0,
                baseWallclockTime: performance.now(),
                baseRTPTimestamp: rtpPacket.readUInt32BE(4),
            }
        }

        this.#ssrcStats[ssrc].packetsSent += 1;
        // TODO: payload may not always start at 12th byte. Check if this is fine.
        this.#ssrcStats[ssrc].payloadBytesSent += rtpPacket.length - 12;
        //console.log('SSRC:', ssrc, 'Packets Sent:', this.#ssrcStats[ssrc].packetsSent, 'Payload Bytes Sent:', this.#ssrcStats[ssrc].payloadBytesSent);

        return rtpPacket
    }

}


        

module.exports = {
    RTPContext
}