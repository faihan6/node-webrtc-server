
const dtls = require('./dtls')
const { SRTPContext } = require('./srtp');
const { Bundle } = require('./bundle');
const { CustomEventTarget } = require('../helpers/common_helper');

const supportedCodecs = {
    audio: globalThis.serverConfig.audioSupportedCodecs,
    video: globalThis.serverConfig.videoSupportedCodecs
}

const supportedHeaderExtensions = globalThis.serverConfig.supportedHeaderExtensions;

/** @enum {string} */
const SIGNALLING_STATE = {
    NEW: 'new',
    HAVE_LOCAL_OFFER: 'have-local-offer',
    HAVE_REMOTE_OFFER: 'have-remote-offer',
    STABLE: 'stable',
    CLOSED: 'closed'
}

class PeerContext extends CustomEventTarget{

    #peerId = null;

    remoteCertificateFingerprint = null;

    #idOfMIDExtension = null;

    #midBundleMap = {};
    #midFingerprintMap = {};

    #midAttributesMap = {};


    rtpStreamSubscriberCallbacks = {};

    #isUsingEncryption = true;

    signallingState = SIGNALLING_STATE.NEW

    remoteOffer = null;

    constructor({id}){
        super();
        this.#peerId = id;
    }

    getTransceivers(){
        const uniqueBundles = new Set(Object.values(this.#midBundleMap));
        const transceivers = []
        uniqueBundles.forEach(bundle => {
            transceivers.push(...bundle.getTransceivers());
        })
        return transceivers;
    }

    setRemoteDescription(offer){
        this.signallingState = SIGNALLING_STATE.HAVE_REMOTE_OFFER;
        this.remoteOffer = offer;

        this.#isUsingEncryption = offer.sdp.match(/a=fingerprint:(.*)/) ? true : false;

        if(!this.#isUsingEncryption){
            if(globalThis.serverConfig.disableWebRTCEncryption){
                console.log(this.#peerId, 'No fingerprint in the offer. Remote Peer wants no encryption')
                this.#isUsingEncryption = false;
            }
            else{
                throw new Error('Fingerprint not found in offer. Rejecting');
            }
        }

        // populate midAttributesMap
        offer.sdp.split('m=').slice(1).forEach(mBlock => {
            const mid = mBlock.match(/a=mid:(.*)/)[1];
            const mediaType = mBlock.split(' ')[0];
            const remoteDirection = mBlock.match(/a=sendrecv|a=recvonly|a=sendonly|a=inactive/)[0].slice(2);
            const selfDirection = (remoteDirection == 'sendonly') ? 'recvonly' :
                                    (remoteDirection == 'recvonly') ? 'sendonly' :
                                    remoteDirection;

            const payloadTypes = this.#extractPayloadTypesFromMBlock(mBlock);
            const extensions = this.#extractExtensionsFromMBlock(mBlock);

            /*
                Read this!
                
                We do not use SSRCs 'primarily' for demuxing. 
                
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

                1. To know the which transceiver a packet belongs to, you need to know the MID
                2. To find the MID from the packet, you need to know the ID of urn:ietf:params:rtp-hdrext:sdes:mid extension.
                3. To know the ID of urn:ietf:params:rtp-hdrext:sdes:mid extension, you need to know the extensionId-URI mapping
                4. extensionId-URI mapping is present in the transceiver. Which transceiver? Go to step 1.

                It is a circular dependency.

                To overcome this, we assume that all transceivers use the same extension ID for urn:ietf:params:rtp-hdrext:sdes:mid extension.
                On checking, this actually holds true for most WebRTC implementations.
            
            */

            extensions.forEach(extension => {
                if(extension.uri == 'urn:ietf:params:rtp-hdrext:sdes:mid'){
                    this.#idOfMIDExtension = extension.id;
                }
            })

            const remoteUfrag = mBlock.match(/a=ice-ufrag:(.*)/)[1];
            const remotePwd = mBlock.match(/a=ice-pwd:(.*)/)[1];
            const remoteCandidates = [];
            mBlock.split('\r\n').forEach(line => {
                if(line.startsWith('a=candidate')){
                    remoteCandidates.push(line);
                }
            });

            const fingerprint = mBlock.match(/a=fingerprint:(.*)/) ? mBlock.match(/a=fingerprint:(.*)/)[1] : null;
            const dtlsSetup = mBlock.match(/a=setup:(.*)/) ? mBlock.match(/a=setup:(.*)/)[1] : null;
            
            this.#midAttributesMap[mid] = {
                mediaType, 
                direction: selfDirection, 
                payloadTypes, 
                extensions,
                remoteUfrag,
                remotePwd,
                remoteCandidates,
                fingerprint,
                dtlsSetup
            };

            console.log(this.#peerId, 'midAttributesMap', this.#midAttributesMap[mid]);
        })


        // There could be multiple BUNDLE lines in the offer.
        if(offer.sdp.includes('a=group:BUNDLE')){

            offer.sdp.split('\r\n')
                .filter(line => line.startsWith('a=group:BUNDLE'))
                .forEach(bundleLine => {

                    const midList = bundleLine.split(' ').slice(1);

                    this.#createBundleForMIDs(midList);
                })
        }
        else{
            // If no bundle, each m-block is a separate bundle.
            offer.sdp.split('m=').slice(1)
                .forEach(mBlock => {
                    const mid = mBlock.match(/a=mid:(.*)/)[1];
                    const midList = [mid];

                    this.#createBundleForMIDs(midList);
                })
        }
    }

    async generateAnswer() {

        const bundleLevelAttributesAdded = new Map();

        for(const bundle of Object.values(this.#midBundleMap)){
            bundleLevelAttributesAdded.set(bundle, false);
        }

        const offer = this.remoteOffer;
        
        if(this.signallingState != SIGNALLING_STATE.HAVE_REMOTE_OFFER){
            throw new Error('Invalid signalling state');
        }

        let answer = '';

        let vBlock = ''
        vBlock += 'v=0\r\n';
        vBlock += 'o=- 0 0 IN IP4 127.0.0.1\r\n';
        vBlock += 's=NODEPEER\r\n';
        vBlock += 't=0 0\r\n';

        // 1. extract all the candidates from the offer
        // deleted..


        let bundleLine = ''
        
        const bundleSet = new Set();
        Object.values(this.#midBundleMap).forEach(bundle => {
            bundleSet.add(bundle);
        })

        bundleSet.forEach(bundle => {
            bundleLine += `a=group:BUNDLE ${bundle.associatedMIDs.map(mid => mid.mid).join(' ')}\r\n`;
        })
        
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

            const payloadTypes = this.#midAttributesMap[mid].payloadTypes;
            const extensions = this.#midAttributesMap[mid].extensions;

            console.log(this.#peerId, `mid: ${mid}, mediaType: ${mediaType}, remoteDirection: ${remoteDirection}, selfDirection: ${selfDirection}, payloadTypes:`, payloadTypes, 'extensions:', extensions);

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
                if(line.startsWith('a=rtcp-fb')){
                    const payloadType = line.match(/a=rtcp-fb:(\d+)/)[1];
                    if(payloadTypes[payloadType] && line.includes('nack')){
                        return true;
                    }
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

            // // add sessionAttributes to first m-block
            // if(i == 0){
            //     let sessAttrBlockFixed = sessionAttributesBlock.endsWith('\r\n') ? sessionAttributesBlock.slice(0, -2) : sessionAttributesBlock;
            //     mBlock += '\r\n' + sessAttrBlockFixed;
            // }

            /**
             * @type {Bundle}
             */
            const bundle = this.#midBundleMap[mid];
            if(!bundleLevelAttributesAdded.get(bundle)){
                bundleLevelAttributesAdded.set(bundle, true);
                
                let bundleLevelAttributesBlock = ''

                // 2. Add the self candidate to answer
                for(const candidateStr of await bundle.iceContext.getLocalCandidates()){
                    bundleLevelAttributesBlock += candidateStr;
                }

            
                // 3. Get remote ICE ufrag and pwd from the offer
                const remoteUfrag = offer.sdp.match(/a=ice-ufrag:(.*)/)[1];
                const remotePwd = offer.sdp.match(/a=ice-pwd:(.*)/)[1];
                bundle.iceContext.setRemoteUfragAndPassword(remoteUfrag, remotePwd);

                // 4. Add self ICE ufrag and pwd to answer
                const selfUfrag = bundle.iceContext.selfUfrag
                const selfPwd = bundle.iceContext.selfPwd
                bundleLevelAttributesBlock += 'a=ice-ufrag:' + selfUfrag + '\r\n';
                bundleLevelAttributesBlock += 'a=ice-pwd:' + selfPwd + '\r\n';

                if(this.#isUsingEncryption){

                    // 6. Add the self certificate fingerprint to answer
                    const fpHash = await dtls.getFingerprintOfCertificate();
                    const formattedFingerprint = this.#formatFingerprint(fpHash)
                    console.log(this.#peerId, 'our fingerprint', formattedFingerprint);
                    bundleLevelAttributesBlock +=  formattedFingerprint + '\r\n';

                    // 6.1 add setup attribute
                    bundleLevelAttributesBlock += 'a=setup:passive\r\n';

                }

                mBlock += '\r\n' + bundleLevelAttributesBlock;
            }

            // add ssrc and stream id
            //TODO: ideally, try to get it from tx.rtpContext.outgoingSSRC

            const tx = bundle.getTransceivers().find(tx => tx.mid == mid);
            console.log(this.#peerId, 'tx', tx);
            const outgoingSSRC = tx.sender.outgoingSSRC;
            const streamId = `stream_${Math.floor(Number(mid) / 2)}`
            const trackId = `track_${Number(mid) % 2}`

            let ssrcLine = `a=ssrc:${outgoingSSRC} msid:${streamId} ${trackId}\r\n`;
            ssrcLine += `a=msid:${streamId} ${trackId}`;

            mBlock += mBlock.endsWith('\r\n') ? ssrcLine : '\r\n' + ssrcLine;

            // 8.2 add m=
            const mLine = `m=${mediaType} 9 UDP/TLS/RTP/SAVPF ${Object.keys(payloadTypes).join(' ')}\r\n`;
            mBlock = mLine + mBlock

            answer += mBlock + '\r\n';


        }

        vBlock += bundleLine


        answer = vBlock + answer;

        this.signallingState = SIGNALLING_STATE.STABLE;
        this.dispatchEvent('signalling_stable');

        return answer;
    }

    #formatFingerprint(hash) {
        // Format the hash as specified
        const formattedFingerprint = hash.match(/.{2}/g).join(':');
        return `a=fingerprint:sha-256 ${formattedFingerprint}`;
    }

    #createBundleForMIDs(midList){

        const isUsingEncryption = this.#isUsingEncryption;
        const remoteFingerPrint = midList.find(mid => this.#midAttributesMap[mid].fingerprint)?.fingerprint;


        console.log(this.#peerId, 'creating bundle for mids', midList)

        const midInfo = midList.map(mid => ({
            mid,
            mediaType: this.#midAttributesMap[mid].mediaType,
            direction: this.#midAttributesMap[mid].direction,
            payloadTypes: this.#midAttributesMap[mid].payloadTypes,
            extensions: this.#midAttributesMap[mid].extensions
        }));

        const bundleParams = {
            isUsingEncryption,
            remoteFingerPrint,
            idOfMIDExtension: this.#idOfMIDExtension
        }

        console.log('bundleParams', bundleParams, this.#idOfMIDExtension);

        const bundle = new Bundle({
            bundleParams,
            associatedMIDs: midInfo,
        });

        midList.forEach(mid => {
            this.#midBundleMap[mid] = bundle;
        })

        return bundle;
    }

    #extractPayloadTypesFromMBlock(mBlock){
        const payloadTypes = {};
        const mediaType = mBlock.split(' ')[0];
        mBlock.split('\r\n').forEach(line => {
            if (line.startsWith('a=rtpmap')) {
                const payloadType = line.match(/a=rtpmap:(\d+)/)[1];
                const codec = line.split(' ')[1]

                if(supportedCodecs[mediaType].some(supportedCodec => codec.includes(supportedCodec))){
                    payloadTypes[payloadType] = codec;
                }
            }
        });

        return payloadTypes;
    }

    #extractExtensionsFromMBlock(mBlock){
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

        return extensions;
    }

}

module.exports = {
    PeerContext
}