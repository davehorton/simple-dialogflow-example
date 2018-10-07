const config = require('config');
const pino = require('pino');
const Srf = require('drachtio-srf');
const srf = new Srf();
const Mrf = require('drachtio-fsmrf');
const customEvents = [
  'dialogflow::intent',
  'dialogflow::transcription',
  'dialogflow::end_of_utterance',
  'dialogflow::audio_provided'
];
const mrf = new Mrf(srf, {customEvents});
const level = config.has('log.level') ? config.get('log.level') : 'info';
const logger = pino({level});

process.on('unhandledRejection', (reason, p) => {
  console.log('Unhandled Rejection at: Promise', p, 'reason:', reason);
});

// connect to freeswitch
function connectMS() {
  return mrf.connect({
    address: config.get('servers.freeswitch.host'),
    port: config.get('servers.freeswitch.port'),
    secret: config.get('servers.freeswitch.secret')
  })
    .then((ms) => {
      logger.info(`successfully connected to media server at ${ms.address}`);
      return ms;
    });
}

// connect to drachtio sip server
srf.connect(config.get('servers.drachtio'))
  .on('connect', (err, hp) => {
    if (err) logger.error(err, 'Error connecting to drachtio');
    else {
      logger.info(`connected to drachtio listening on ${hp}`);
      connectMS()
        .then((ms) => srf.locals.ms = ms)
        .catch((err) => {
          logger.error(err, 'Error connecting to media server');
        });
    }
  })
  .on('error', (err) => logger.error(err, 'drachtio connection error'));


// handle incoming INVITE
srf.invite(handleInvite);

// this is where the fun happens..
async function handleInvite(req, res) {
  const callId = req.get('Call-ID');
  logger.info({callId}, `received incoming call: ${req.uri}`);

  // connect call to media server, producing media Endpoint and SipDialog objects
  const {endpoint, dialog} = await srf.locals.ms.connectCaller(req, res, { codecs: ['PCMU'] });

  /* set dialog event flow handlers.  We will be notified of the following events:
   * (1) An Intent was detected.
   * (2) A Transcription was provided
   * (3) An audio clip has been provided that we can play
   * (4) The user just stopped speaking
   * (5) An error was detected.
  */

  endpoint.on('dialogflow::intent', handleIntent.bind(endpoint, dialog));
  endpoint.on('dialogflow::transcription', handleTranscription.bind(endpoint));
  endpoint.on('dialogflow::audio_provided', handleAudio.bind(endpoint, dialog));
  endpoint.on('dialogflow::end_of_utterance', handleEndOfUtterance.bind(endpoint));
  endpoint.on('dialogflow::error', handleError.bind(endpoint));

  // when the caller hangs up, destroy the media endpoint and terminate the dialogflow
  dialog.on('destroy', () => {
    logger.info('got BYE from caller, hangup');
    endpoint.destroy();
  });

  // kick things off by starting the dialog flow.
  // in this app we have hardcoded parameters that would normally be provided based on the DID
  //    agent: rising-af044
  //    language code: en-US
  //    speech timeout: 20 secs (not yet implemented)
  //    event: welcome (this is optional)
  endpoint.api('dialogflow_start', `${endpoint.uuid} rising-af044 en-US 20 welcome`);
}

// event handler: we just received an intent
//  action: if 'end_interaction' is true, end the dialog after playing the final prompt
//  (or in 1 second if there is no final prompt)
function handleIntent(dlg, intent) {
  logger.info(`got intent: ${JSON.stringify(intent)}`);
  if (intent.query_result.intent.end_interaction) {
    this.hangupAfterPlayDone = true;
    this.waitingForPlayStart = true;
    setTimeout(() => {
      if (this.waitingForPlayStart) dlg.destroy();
    }, 1000);
  }
}

// event handler: we just received a transcription
//    action: nothin, just log the transcription if this was a final transcription
function handleTranscription(transcription) {
  if (transcription.recognition_result.is_final) {
    logger.info(`got transcription: ${JSON.stringify(transcription)}`);
  }
}

// event handler: we just got an audio clip we can play
//    action: play the clip, and when it ends send another DialogIntentRequest
async function handleAudio(dlg, audio) {
  logger.info(`got audio file to play: ${audio.path}`);
  this.waitingForPlayStart = false;
  await this.play(audio.path);
  if (this.hangupAfterPlayDone) dlg.destroy();
  else this.api('dialogflow_start', `${this.uuid} rising-af044 en-US 20`);
}

// event handler: speaker just completed saying something
//    action: nothing, just log the event
function handleEndOfUtterance(obj) {
  logger.info(`got end of utterance: ${JSON.stringify(obj)}`);
}

// event handler: dialog flow error of some kind
//    action: just log it
function handleError(error) {
  logger.info(`got error: ${JSON.stringify(error)}`);
}
