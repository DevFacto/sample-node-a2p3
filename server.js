/*
* server.js
*
* Sample App
*
* gets all profile data about a user and displays it
*
* Copyright (C) Province of British Columbia, 2013
*/


var express = require('express')
  , app = express()
  , fs = require('fs')
  , os = require('os')
  , a2p3 = require('a2p3')

// make sure you have a config.json and vault.json per a2p3 documentation
a2p3.init( require('./config.json'), require('./vault.json'))

var LISTEN_PORT = 8080
var HOST_URL = null

if (process.env.DOTCLOUD_WWW_HTTP_URL) {  // looks like we are running on DotCloud, adjust our world
  HOST_URL = 'https://' + process.env.DOTCLOUD_WWW_HTTP_HOST
  LISTEN_PORT = 8080
}

function makeHostUrl (req) {
  if (HOST_URL) return HOST_URL
  // make URL from URL we are running on
  var hostURL = req.protocol + '://' + req.host
  if (LISTEN_PORT) hostURL += ':' + LISTEN_PORT
  return hostURL
}

var RESOURCES =
    [ 'http://email.a2p3.net/scope/default'
    , 'http://people.a2p3.net/scope/details'
    , 'http://si.a2p3.net/scope/number'
    , 'http://health.a2p3.net/scope/prov_number'
    ]

var APIS =
  { 'http://email.a2p3.net/email/default': null
  , 'http://people.a2p3.net/details': null
  , 'http://si.a2p3.net/number': null
  , 'http://health.a2p3.net/prov_number': null
  }

// HTML for meta refresh and Agent Install Page
// we could read this in once, but reading it in each
// time makes it easy to edit and reload for development
var META_REFRESH_HTML_FILE = __dirname + '/html/meta_refresh.html'


/*
*  Users can use the Agent running on their mobile phone to log into a web site
*  The server sends a qrURL down to the web page which draws a QR code
*  When the WR reader on the Agent reads the QR code, it appends &json=true
*  and the server then responds with a JSON response
*  If the QR code is scanned with a standard reader, then the server returns
*  the agent_install.html page which then tries to redirect the user to
*  Agent scheme. If it is not successful, the User learns how to get an Agent
*  for their phone
*
*  When an Agent is scanning the QR code, the User is running the App on a different
*  device. We use the sessions object to pass the Agent Request and IX Token that
*  we get from the Agent to the session where the App is running
*
*/

// calculate this once
var QR_SESSION_LENGTH = a2p3.random16bytes().length

// Global for holding QR sessions, need to put in DB if running mulitple instances
// NOTE: DOES NOT SCALE AS CODED
// checkForTokenRequest and storeTokenRequest are coded with callbacks so that
// they can easily be implemented to store data in a DB
var sessions = {}

// checks if we are have received the IX Token and Agent Request from the Agent
function checkForTokenRequest ( qrSession, callback ) {
  if ( !sessions[ qrSession ] || !sessions[ qrSession ].ixToken ) return callback( null, null )
  var data = JSON.parse( JSON.stringify( sessions[ qrSession ] ) )
  delete sessions[ qrSession ]
  callback( data )
}

// stores IX Token and Agent Request we received back channel from the Agent
function storeTokenRequest ( qrSession, agentRequest, ixToken, notificationURL, callback ) {
  sessions[ qrSession ] = sessions[ qrSession ] || {} // we might have a remember property stored
  sessions[ qrSession ].ixToken = ixToken
  sessions[ qrSession ].agentRequest = agentRequest
  sessions[ qrSession ].notificationURL = notificationURL
  callback( null )
}

function storeRememberMe ( qrSession, remember, callback ) {
  sessions[ qrSession ] = sessions[ qrSession ] || {}
  sessions[ qrSession ].remember = remember
  callback( null )
}

function checkRememberMe ( qrSession, callback ) {
  var remember = sessions[ qrSession ] && sessions[ qrSession ].remember
  callback( null, remember )
}

// metaRedirectInfoPage() returns a meta-refresh page with the supplied URL
function metaRedirectInfoPage ( redirectURL ) {
  var html = fs.readFileSync( META_REFRESH_HTML_FILE, 'utf8' )
  return html.replace( '$REDIRECT_URL', redirectURL )
}

function fetchProfile( agentRequest, ixToken, callback ) {
  var resource = new a2p3.Resource()
  resource.exchange( agentRequest, ixToken, function ( error, di ) {
    if ( error ) return callback ( error )
    var userDI = di // App's directed identifier for User
    resource.callMultiple( APIS, function ( error, results ) {
      if (results)
        results['ix.a2p3.net'] = { di: userDI }
      callback( error, results )
    })
  })
}


/*
*   request handlers
*/

// loginQR() - called by web app when it wants a QR code link
// creates an agentRequest and state
function loginQR( req, res )  {
  var qrSession = a2p3.random16bytes()
  req.session.qrSession = qrSession
  var qrCodeURL = makeHostUrl( req ) + '/QR/' + qrSession
  res.send( { result: { qrURL: qrCodeURL, qrSession: qrSession } } )
}

// loginDirect -- loaded when web app thinks it is running on a mobile device that
// can support the agent
// we send a meta-refresh so that we show a info page in case there is no agent to
// handle the a2p3.net: protcol scheme
function loginDirect( req, res ) {
  var agentRequest = a2p3.createAgentRequest( makeHostUrl( req ) + '/response', RESOURCES )
  var redirectURL = 'a2p3.net://token?request=' + agentRequest
  var html = metaRedirectInfoPage( redirectURL )
  res.send( html )
}

// loginBackdoor -- development login that uses a development version of setup.a2p3.net
function loginBackdoor( req, res )  {
  var agentRequest = a2p3.createAgentRequest( makeHostUrl( req ) + '/response', RESOURCES )
  var redirectURL = 'http://setup.a2p3.net/backdoor/login?request=' + agentRequest
  res.redirect( redirectURL )
}


// clear session, logout user
function logout( req, res )  {
  req.session = null
  res.redirect('/')
}


// QR Code was scanned
// if scanned by Agent, then 'json=true' has been set and we return the Agent Request in JSON
// if scanned by a general QR reader, then return a meta refresh page with Agent Reqeuest and
// and state parameter of qrSession so we can link the response from the Agent
// back to this web app session in checkQR
function qrCode( req, res ) {
  var qrSession = req.params.qrSession
  // make sure we got something that looks like a qrSession
  if ( !qrSession || qrSession.length != QR_SESSION_LENGTH || qrSession.match(/[^\w-]/g) ) {
    return res.redirect('/error')
  }
  checkRememberMe( qrSession, function ( e, remember ) {

console.log('qrCode',remember)

    // ignore error since we can't do anything about it
    var agentRequest = a2p3.createAgentRequest( makeHostUrl( req ) + '/response', RESOURCES )
    var json = req.query.json
    if ( json ) {
      var response = { result: { agentRequest: agentRequest, state: qrSession } }
      if (remember) response.result.notificationURL = true
      return res.send( response )
    } else {
      var redirectURL = 'a2p3://token?request=' + agentRequest + '&state=' + qrSession
      if (remember) redirectURL += '&notificationURL=true'
      var html =  metaRedirectInfoPage( redirectURL )
      return res.send( html )
    }
  })

}

/*
if we are getting a state parameter, we are getting the data
directly from the Agent and not via a redirect to our app
*/

function loginResponse( req, res )  {
  var ixToken = req.query.token
  var agentRequest = req.query.request
  var qrSession = req.query.state
  var notificationURL = req.query.notificationURL

  if (!ixToken || !agentRequest) {
    return res.redirect( '/error' )
  }
  if ( qrSession ) {
    storeTokenRequest( qrSession, agentRequest, ixToken, notificationURL, function ( error ) {
      if ( error ) return res.redirect( '/error' )
      return res.redirect( '/complete' )
    })
  } else {
    // NOTE: we should not get a notificationURL here as we came back direct, not a QR scan
    fetchProfile( agentRequest, ixToken, function ( error, results ) {
      if ( error ) return res.redirect( '/error' )
      req.session.profile = results
      return res.redirect('/')
    })
  }
}




function checkQR( req, res ) {
  if (!req.body.qrSession)
    return res.send( { error: 'No QR Session provided' } )
  checkForTokenRequest( req.body.qrSession, function ( response ) {
    if (!response) {
      return res.send( { status: 'waiting'} )
    }

// TBD: save notificationURL to cookie or something so we can remember user

    fetchProfile( response.agentRequest, response.ixToken, function ( error, results ) {
      var response = {}
      if ( error ) response.error = error
      if ( results ) {
        response.result = results
        req.session.profile = results
      }
      return res.send( response )
    })
  })
}

function rememberMe( req, res ) {
  var remember = req.body.remember
  var qrSession = req.session.qrSession
  if (!remember || !qrSession) return res.send({ error: 'no remember or QR session'})

console.log('\nrememberMe remember',remember,' qrSession:',qrSession)

  storeRememberMe( qrSession, remember, function ( e ) {
    if (e) return res.send( { error: e  } )
    return res.send( { result: { success: true } } )
  })
}


function profile( req, res )  {
  if ( req.session.profile ) {
    return res.send( { result: req.session.profile } )
  } else { //
    return res.send( { errror: 'NOT_LOGGED_IN'} )
  }
}

// set up middleware

app.use( express.static( __dirname + '/html/assets' ) )   // put static assets here
app.use( express.logger( 'dev' ) )                        // so that we only log page requests
app.use( express.limit('10kb') )                          // protect against large POST attack
app.use( express.bodyParser() )

app.use( express.cookieParser() )                   // This does not scale to more than one machine
var cookieOptions =                                 // Put in DB backend for session to scale
  { 'secret': a2p3.random16bytes()
  , 'cookie': { path: '/' } }
app.use( express.cookieSession( cookieOptions ))

//setup request routes

// these end points are all AJAX calls from the web app and return a JSON response
app.get('/login/QR', loginQR )
app.get('/profile', profile )
app.post('/check/QR', checkQR )
app.post('/remember/me', rememberMe )

// this page is called by either the Agent or a QR Code reader
// returns either the Agent Request in JSON if called by Agent
// or sends a redirect to the a2p3.net://token URL
// also called by the Agent via the notification URL mechanism
app.get('/QR/:qrSession', qrCode )


// these pages return a redirect
app.get('/login/backdoor', loginBackdoor)
app.get('/login/direct', loginDirect)
app.get('/response', loginResponse )
app.get('/logout', logout )

// these endpoints serve static HTML pages
app.get('/', function( req, res ) { res.sendfile( __dirname + '/html/index.html' ) } )
app.get('/error', function( req, res ) { res.sendfile( __dirname + '/html/login_error.html' ) } )
app.get('/complete', function( req, res ) { res.sendfile( __dirname + '/html/login_complete.html' ) } )
app.get('/agent/install', function( req, res ) { res.sendfile( __dirname + '/html/agent_install.html' ) } )


app.get('/test', function( req, res ) { res.sendfile( __dirname + '/html/test.html' ) } )


app.listen( LISTEN_PORT )

console.log('\nSample App started and listening on ', LISTEN_PORT )
