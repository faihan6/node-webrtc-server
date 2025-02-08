
const { ICEContext } = require('./stun');
const { DTLSContext, getFingerprintOfCertificate } = require('./dtls')
const { RTPContext } = require('./rtp');
const { SRTPContext } = require('./srtp');
const { SimpleStream } = require('../helpers/simple_stream');
const { Transceiver } = require('./transceiver');
const { CustomEventTarget } = require('../helpers/common_helper');

const supportedCodecs = {
    audio: globalThis.serverConfig.audioSupportedCodecs,
    video: globalThis.serverConfig.videoSupportedCodecs
}

const supportedHeaderExtensions = globalThis.serverConfig.supportedHeaderExtensions;

class PeerContext extends CustomEventTarget{

    #peerId = null;

    remoteCertificateFingerprint = null;

    ssrcMIDMap = {};
    idOfMIDExtension = null;

    /**
     * We support only BUNDLEing, so there is only one ice context per peer
     */
    iceContext = new ICEContext({onPacketReceived: this.allocatePacketToAppropriateMethod.bind(this)});

    // TODO: direction is a property of transceiver, not peer itself. need to change it.
    selfDirection = null;
    remoteDirection = null;

    rtpStreamSubscriberCallbacks = {};

    #remoteSSRCStreams = {
        null: {
            rtp: new SimpleStream(),
            rtcpEvents: new SimpleStream()
        }
    };
    #localSSRCStreams = {};

    #dtlsContext = new DTLSContext();
    #srtpContext = new SRTPContext();

    #rtpContext = new RTPContext()


    transceivers = {};

    #isUsingEncryption = true;

    constructor({id}){

        super();

        this.#peerId = id;

        this.#dtlsContext.addEventListener('dtlsParamsReady', params => {
            this.#srtpContext.initSRTP(params);
        });

        this.#rtpContext.addEventListener('send_rtp_o_to_client', packet => {
            const extensionsInfo = RTPContext.parseHeaderExtensions(packet);
            if(this.#isUsingEncryption){
                packet = this.#srtpContext.encryptPacket(packet, extensionsInfo)
            }
            this.iceContext.sendPacket(packet);
        })

        this.#rtpContext.addEventListener('send_fb_i_to_client', packet => {
            if(this.#isUsingEncryption){
            packet = this.#srtpContext.encryptPacket(packet)
            }
            //console.log(this.#peerId, 'send_fb_i_to_client event arrived', encryptedPacket.slice(15))
            this.iceContext.sendPacket(packet);
        })
    }

    async generateAnswer(offer) {

        let answer = '';

        let vBlock = ''
        vBlock += 'v=0\r\n';
        vBlock += 'o=- 0 0 IN IP4 127.0.0.1\r\n';
        vBlock += 's=NODEPEER\r\n';
        vBlock += 't=0 0\r\n';

        let sessionAttributesBlock = ''

        // 1. extract all the candidates from the offer
        const remoteCandidates = [];
        offer.sdp.split('\r\n').forEach(line => {
            if (line.startsWith('a=candidate')) {
                remoteCandidates.push(line);
            }
        });

        // 2. Add the self candidate to answer
        for(const candidateStr of this.iceContext.getCandidates()){
            sessionAttributesBlock += candidateStr;
        }

    
        // 3. Get remote ICE ufrag and pwd from the offer
        const remoteUfrag = offer.sdp.match(/a=ice-ufrag:(.*)/)[1];
        const remotePwd = offer.sdp.match(/a=ice-pwd:(.*)/)[1];
        this.iceContext.setRemoteUfragAndPassword(remoteUfrag, remotePwd);

        // 4. Add self ICE ufrag and pwd to answer
        const selfUfrag = this.iceContext.selfUfrag
        const selfPwd = this.iceContext.selfPwd
        sessionAttributesBlock += 'a=ice-ufrag:' + selfUfrag + '\r\n';
        sessionAttributesBlock += 'a=ice-pwd:' + selfPwd + '\r\n';

        
        const certificateFPInOffer = offer.sdp.match(/a=fingerprint:(.*)/);
        if(certificateFPInOffer){

            // 5. Get the certificate fingerprint from the offer
            const remoteCertificateFingerprint = certificateFPInOffer[1];
            this.#dtlsContext.setRemoteFingerprint(remoteCertificateFingerprint);


            // 6. Add the self certificate fingerprint to answer
            const fp = this.formatFingerprint(await getFingerprintOfCertificate())
            console.log(this.#peerId, 'our fingerprint', fp);
            sessionAttributesBlock +=  (fp) + '\r\n';

            // 6.1 add setup attribute
            sessionAttributesBlock += 'a=setup:passive\r\n';
        }
        else{
            if(globalThis.serverConfig.disableWebRTCEncryption){
                console.log(this.#peerId, 'No fingerprint in the offer. Remote Peer wants no encryption')
                this.#isUsingEncryption = false;
            }
            else{
                throw new Error('Fingerprint not found in offer. Rejecting');
            }
        }


        let bundleLine = 'a=group:BUNDLE'
        
        const mBlocks = offer.sdp.split('m=').slice(1);
        for(let i = 0; i < mBlocks.length; i++){

            let mBlock = mBlocks[i];

            // 7. populate the transceivers
            const mediaType = mBlock.split(' ')[0];
            console.log(this.#peerId, 'mBlock:', mediaType);

            const mid = mBlock.match(/a=mid:(.*)/)[1];
            const remoteDirection = mBlock.match(/a=sendrecv|a=recvonly|a=sendonly|a=inactive/)[0].slice(2);
            const selfDirection = (remoteDirection == 'sendonly') ? 'recvonly' :
                                    (remoteDirection == 'recvonly') ? 'sendonly' :
                                    remoteDirection;

            const payloadTypes = {};
            mBlock.split('\r\n').forEach(line => {
                if (line.startsWith('a=rtpmap')) {
                    const payloadType = line.match(/a=rtpmap:(\d+)/)[1];
                    const codec = line.split(' ')[1]

                    if(supportedCodecs[mediaType].some(supportedCodec => codec.includes(supportedCodec))){
                        payloadTypes[payloadType] = codec;
                    }
                }
            });

            const extensions = [];

            mBlock.split('\r\n').forEach(line => {
                if(!line.startsWith('a=extmap')){
                    return;
                }
                if(supportedHeaderExtensions.some(supportedExtension => line.includes(supportedExtension))){
                    const id = line.match(/a=extmap:(\d+)/)[1];
                    const uri = line.split(' ')[1];
                    extensions.push({id, uri});
                }
            })

            /*
                Read this!
                
                We do not use SSRCs primarily for demuxing. 
                
                We use MIDs specified in packets (header extensions) to demux RTP packets from single ICE transport, 
                and send them to appropriate transceivers.

                The extension is defined in the packet as <ID, Length, MID> where
                    - ID is the ID specified in the extension map specified in SDP. (a=extmap:<id>)
                    - MID is the actual MID of the packet.

                Extension mapping is specific to each m-block, a.k.a Transceiver. Each transceiver has its own extension mapping.

                Example, 
                    - transceiver 1 might have extension mapping as a=extmap:9 urn:ietf:params:rtp-hdrext:sdes:mid,
                    - transceiver 2 might have extension mapping as a=extmap:4 urn:ietf:params:rtp-hdrext:sdes:mid

                So, when you parse a packet, you get the MID in <ID, Length, MID> format.

                Here is the problem,

                1. To know the transceiver, you need to know the MID
                2. To find the MID from the packet, you need to know the ID of urn:ietf:params:rtp-hdrext:sdes:mid extension.
                3. To know the ID of urn:ietf:params:rtp-hdrext:sdes:mid extension, you need to know the extensionId-URI mapping
                4. extensionId-URI mapping is present in the transceiver.

                It is a circular dependency.

                To overcome this, we assume that all transceivers use the same extension ID for urn:ietf:params:rtp-hdrext:sdes:mid extension.
                On checking, this actually holds true for most WebRTC implementations.
            
            */

            extensions.forEach(extension => {
                if(extension.uri == 'urn:ietf:params:rtp-hdrext:sdes:mid'){
                    this.idOfMIDExtension = extension.id;
                }
            })

            console.log(this.#peerId, `mid: ${mid}, mediaType: ${mediaType}, remoteDirection: ${remoteDirection}, selfDirection: ${selfDirection}, payloadTypes:`, payloadTypes, 'extensions:', extensions);

            const tx = new Transceiver({mid, mediaType, direction: selfDirection, payloadTypes, extensions});
            this.transceivers[mid] = tx;
            this.#listenForTxEvents(tx);

            // 8. add m-blocks to answer
            // 8.1 replace remote direction with self direction
            mBlock = mBlock.replace(`a=${remoteDirection}`, `a=${selfDirection}`);
            
            // remove unwanted attributes
            mBlock = mBlock.split('\r\n').filter(line => {
                if (line.startsWith('a=rtcp-mux')) {
                    return true;
                }
                if (line.startsWith('a=rtcp-rsize')) {
                    return true;
                }
                if (line.startsWith('a=rtpmap') && (line.includes('VP8') || line.includes('opus'))) {
                    return true;
                }
                if (line.startsWith('a=mid')) {
                    return true;
                }
                if(line.startsWith('a=extmap') && supportedHeaderExtensions.some(supportedExtension => line.includes(supportedExtension))){
                    return true;
                }
                if(line.startsWith('a=sendrecv') || line.startsWith('a=recvonly') || line.startsWith('a=sendonly') || line.startsWith('a=inactive')){
                    return true;
                }
                return false;
            }).join('\r\n');

            // add sessionAttributes to first m-block
            if(i == 0){
                let sessAttrBlockFixed = sessionAttributesBlock.endsWith('\r\n') ? sessionAttributesBlock.slice(0, -2) : sessionAttributesBlock;
                mBlock += '\r\n' + sessAttrBlockFixed;
            }

            // 8.2 add m=
            const mLine = `m=${mediaType} 9 UDP/TLS/RTP/SAVPF ${Object.keys(payloadTypes).join(' ')}\r\n`;
            mBlock = mLine + mBlock

            answer += mBlock + '\r\n';

            // 8.3 add mid to BUNDLE
            bundleLine += ` ${mid}`


        }

        vBlock += bundleLine + '\r\n'


        answer = vBlock + answer;

        this.dispatchEvent('signalling_stable');

        return answer;
    }

    #listenForTxEvents(tx){
    
        tx.addEventListener('rtp_for_client', packet => {
            this.#rtpContext.handleRTPToClient(packet);
        })
    }

    formatFingerprint(hash) {
        // Format the hash as specified
        const formattedFingerprint = hash.match(/.{2}/g).join(':');
        return `a=fingerprint:sha-256 ${formattedFingerprint}`;
    }

    allocatePacketToAppropriateMethod(packet, remote){
        
        if(packet.at(0) == 0x16){
            // DTLS
            const response = this.#dtlsContext.handleDTLS(packet);
            this.iceContext.sendPacket(response, remote);
        }
        else if(packet.at(0) >> 6 == 0x02){
            
            const rtpPayloadType = packet.readUInt8(1) & 0b01111111;
            const rtcpPacketType = packet.readUInt8(1);

            const extensionsInfo = RTPContext.parseHeaderExtensions(packet);

            if(this.#isUsingEncryption){
                packet = this.#srtpContext.decryptPacket(packet, extensionsInfo);
            }

            if((rtpPayloadType >= 96 && rtpPayloadType <= 127)){
                // RTP-i
                this.#rtpContext.handleRTPFromClient(packet);
            }
            else{
                // SR-i and FB-o
                this.#rtpContext.handleFeedbackFromClient(packet);
            }

            this.#incomingRTPDemuxer(packet, extensionsInfo);


        }
    }

    #incomingRTPDemuxer(packet, extensionsInfo){
        // identify mid from packet

        const rtpPayloadType = packet.readUInt8(1) & 0b01111111;
        const rtcpPacketType = packet.readUInt8(1);

        let ssrc;

        if(rtpPayloadType >= 96 && rtpPayloadType <= 127){
            ssrc = packet.readUInt32BE(8);
        }
        else if(rtcpPacketType == 206){
            ssrc = packet.readUInt32BE(8);
        }
        else{
            ssrc = packet.readUInt32BE(4);
        }


        //const ssrc = packet.readUInt32BE(8);

        let mid;
        let source;
        if(extensionsInfo && extensionsInfo.areExtensionsPresent){
            const midExtension = extensionsInfo.extensions.find(ext => ext.id == this.idOfMIDExtension);
            mid = midExtension.value.toString('utf8');
            source = 'extension';

            this.ssrcMIDMap[ssrc] = mid;
        }

        if(mid == null || mid == undefined){
            
            mid = this.ssrcMIDMap[ssrc];
            source = 'ssrc';
        }

        if(mid == null || mid == undefined){
            console.log(this.#peerId, 'mid not found for ssrc', ssrc, 'rtpPayloadType', rtpPayloadType, 'rtcpPayloadType', rtcpPacketType, packet.slice(0,35));
            return;
        }

        const tx = this.transceivers[mid];
        
        if(rtpPayloadType >= 96 && rtpPayloadType <= 127){
            // RTP-i
            tx.writeRTPToConsumer(packet);
        }
        else if(rtcpPacketType == 200){
            // FB-i
            // nothing to do here 
        }
        else if(rtcpPacketType >= 201 && rtcpPacketType <= 206){
            // FB-o
            const mediaSourceSSRC = packet.readUInt32BE(8);
            console.log(this.#peerId, rtcpPacketType, 'ssrc', ssrc, 'mid', mid, 'source', source, 'mediaSourceSSRC', mediaSourceSSRC);
            tx.writeFeedbackToProducer(packet);
        }

    }

}

module.exports = {
    PeerContext
}