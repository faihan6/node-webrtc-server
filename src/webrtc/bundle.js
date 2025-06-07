const { TxController, Transceiver } = require("./transceiver");
const { ICEContext } = require("./ice");
const { DTLSContext } = require("./dtls");
const { SRTPContext } = require("./srtp");
const { RTPHelpers } = require("./rtp");

class Bundle{

    #isUsingEncryption = false;
    #ssrcMIDMap = {};
    #remoteFingerPrint = null;

    iceContext = new ICEContext({onPacketReceived: this.#allocatePacketToAppropriateMethod.bind(this)});

    /** @type {DTLSContext} */
    #dtlsContext = null;

    /** @type {SRTPContext} */
    #srtpContext = null;

    #transceivers = {};
    #txControllers = {};

    #associatedMIDs = [];

    #idOfMIDExtension = null;

    constructor({bundleParams, associatedMIDs}){

        console.log('bundleParams inside bundle constructor', bundleParams);
        this.#isUsingEncryption = bundleParams.isUsingEncryption;
        this.#associatedMIDs = associatedMIDs;
        this.#idOfMIDExtension = bundleParams.idOfMIDExtension;
        
        if(this.#isUsingEncryption){
            
            this.#remoteFingerPrint = bundleParams.remoteFingerPrint;
            this.#dtlsContext = new DTLSContext();
            this.#dtlsContext.setRemoteFingerprint(this.#remoteFingerPrint);

            this.#srtpContext = new SRTPContext();

            this.#dtlsContext?.addEventListener('dtlsParamsReady', params => {
                this.#srtpContext.initSRTP(params);
            });

        }

        this.#associatedMIDs.forEach(midInfo => {
            const {mid, mediaType, direction, payloadTypes, extensions} = midInfo;
            const controller = new TxController();
            const tx = new Transceiver({
                mid, 
                mediaType, 
                direction, 
                payloadTypes, 
                extensions,
                controller
            });
            this.#txControllers[mid] = controller;
            this.#transceivers[mid] = tx;

            controller.addEventListener('send_fb_i_to_client', (packet) => this.#sendPacketToRemote(packet));
            controller.addEventListener('send_rtp_o_to_client', (packet) => this.#sendPacketToRemote(packet));
        })
    }

    get associatedMIDs(){
        return this.#associatedMIDs;
    }

    getTransceivers(){
        return Object.values(this.#transceivers);
    }

    #allocatePacketToAppropriateMethod(packet, remote){
        
        if(packet.at(0) == 0x16 && this.#dtlsContext){
            // DTLS
            const response = this.#dtlsContext.handleDTLS(packet);
            this.iceContext.sendPacket(response, remote);
        }
        else if(packet.at(0) >> 6 == 0x02){
            // RTP/RTCP
            this.#incomingRTPDemuxer(packet);    
        }
    }

    #incomingRTPDemuxer(packet){

        try{
            // TODO: decrypt before demuxing
            if(this.#isUsingEncryption){
                /*
                    Ideally, we should have a separate SRTPContext for each BUNDLE.
                    And use the appropriate SRTPContext instead of this.#srtpContext
                */
                const extensionsInfo = RTPHelpers.parseHeaderExtensions(packet);
                packet = this.#srtpContext.decryptPacket(packet, extensionsInfo);

                if(packet == null){
                    console.log('packet is null after decryption');
                    return;
                }
            }

            const rtpPayloadType = packet[1] & 0b01111111;

            if(rtpPayloadType >= 96 && rtpPayloadType <= 127){
                const ssrc = packet.readUInt32BE(8);
                const extensionsInfo = RTPHelpers.parseHeaderExtensions(packet);
                const {mid} = this.#identifyMIDOfPacket(packet, ssrc, extensionsInfo);
                this.#txControllers[mid]?.write(packet)
            }
            else{
                // It is a RTCP packet. Probably a compound one!

                const packets = RTPHelpers.splitCompoundRTCPPacket(packet);
                if(packets.length > 1){
                    //console.log('compound RTCP packet', packets.length, packets);
                }
                for(const packet of packets){
                    const ssrc = RTPHelpers.identifySSRCofRTCPPacket(packet);
                    const {mid} = this.#identifyMIDOfPacket(packet, ssrc);
                    this.#txControllers[mid]?.write(packet)
                }
            }
            
        }
        catch(e){
            console.error('error in demuxing', e, packet);
        }
    }

    #identifyMIDOfPacket(packet, ssrc, extensionsInfo){
        let mid;
        let source;
        if(extensionsInfo && extensionsInfo.areExtensionsPresent){
            const midExtension = extensionsInfo.extensions.find(ext => ext.id == this.#idOfMIDExtension);
            mid = midExtension.value.toString('utf8');
            source = 'extension';

            this.#ssrcMIDMap[ssrc] = mid;
        }

        if(mid == null || mid == undefined){
            
            mid = this.#ssrcMIDMap[ssrc];
            source = 'ssrc';
        }

        const rtcpPacketType = packet[1];
        if(rtcpPacketType >= 200 && rtcpPacketType <= 206){
            // this is a RTCP packet! allocate it to the correct transceiver
            const tx = Object.values(this.#transceivers).find(tx => tx.sender.outgoingSSRC == ssrc);
            if(tx){
                //console.log(this.#peerId, 'tx found for ssrc', ssrc, tx.sender.outgoingSSRC);
                mid = tx.mid;
                source = 'SDP';
                this.#ssrcMIDMap[ssrc] = mid;
            }
        }
        

        if(mid == null || mid == undefined){
            console.log('mid not found for ssrc', ssrc, packet.slice(0,35));
        }

        return {mid, source};
    }

    #sendPacketToRemote(packet){
        if(this.#isUsingEncryption){
            const extensionsInfo = RTPHelpers.parseHeaderExtensions(packet);
            packet = this.#srtpContext.encryptPacket(packet, extensionsInfo);
        }
        this.iceContext.sendPacket(packet);
    }

}

module.exports = {
    Bundle
}