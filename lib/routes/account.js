/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

'use strict'

const butil = require('../crypto/butil')
const error = require('../error')
const isA = require('joi')
const METRICS_CONTEXT_SCHEMA = require('../metrics/context').schema
const P = require('../promise')
const random = require('../crypto/random')
const requestHelper = require('../routes/utils/request_helper')
const userAgent = require('../userAgent')
const uuid = require('uuid')
const validators = require('./validators')

const HEX_STRING = validators.HEX_STRING
const BASE_36 = validators.BASE_36

// An arbitrary, but very generous, limit on the number of active sessions.
// Currently only for metrics purposes, not enforced.
const MAX_ACTIVE_SESSIONS = 200

const MS_ONE_DAY = 1000 * 60 * 60 * 24
const MS_ONE_WEEK = MS_ONE_DAY * 7
const MS_ONE_MONTH = MS_ONE_DAY * 30

module.exports = (
  log,
  db,
  bounces,
  mailer,
  Password,
  config,
  customs,
  checkPassword,
  push
  ) => {

  const getGeoData = require('../geodb')(log)
  const features = require('../features')(config)
  const marketingCache = require('../cache')(log, config, 'fxa-marketing~')
  const verificationReminder = require('../verification-reminders')(log, db)

  const unblockCodeLifetime = config.signinUnblock && config.signinUnblock.codeLifetime || 0
  const unblockCodeLen = config.signinUnblock && config.signinUnblock.codeLength || 0

  const routes = [
    {
      method: 'POST',
      path: '/account/create',
      config: {
        validate: {
          query: {
            keys: isA.boolean().optional(),
            service: validators.service
          },
          payload: {
            email: validators.email().required(),
            authPW: isA.string().min(64).max(64).regex(HEX_STRING).required(),
            preVerified: isA.boolean(),
            service: validators.service,
            redirectTo: validators.redirectTo(config.smtp.redirectDomain).optional(),
            resume: isA.string().max(2048).optional(),
            metricsContext: METRICS_CONTEXT_SCHEMA,
            marketingOptIn: isA.boolean()
          }
        },
        response: {
          schema: {
            uid: isA.string().regex(HEX_STRING).required(),
            sessionToken: isA.string().regex(HEX_STRING).required(),
            keyFetchToken: isA.string().regex(HEX_STRING).optional(),
            authAt: isA.number().integer()
          }
        }
      },
      handler: function accountCreate(request, reply) {
        log.begin('Account.create', request)

        const form = request.payload
        const query = request.query
        const email = form.email
        const authPW = form.authPW
        const locale = request.app.acceptLanguage
        const userAgentString = request.headers['user-agent']
        const service = form.service || query.service
        const preVerified = !! form.preVerified
        const ip = request.app.clientAddress
        const marketingOptIn = form.marketingOptIn
        let password, verifyHash, account, sessionToken, keyFetchToken, emailCode, tokenVerificationId, authSalt

        request.validateMetricsContext()

        // Store flowId and flowBeginTime to send in email
        let flowId, flowBeginTime
        if (request.payload.metricsContext) {
          flowId = request.payload.metricsContext.flowId
          flowBeginTime = request.payload.metricsContext.flowBeginTime
        }

        customs.check(request, email, 'accountCreate')
          .then(db.emailRecord.bind(db, email))
          .then(deleteAccountIfUnverified, checkAccountError)
          .then(setMetricsFlowCompleteSignal)
          .then(generateRandomValues)
          .then(createPassword)
          .then(createAccount)
          .then(createSessionToken)
          .then(sendVerifyCode)
          .then(createKeyFetchToken)
          .then(recordSecurityEvent)
          .then(createResponse)
          .then(reply, reply)

        function deleteAccountIfUnverified (emailRecord) {
          if (emailRecord.emailVerified) {
            throw error.accountExists(emailRecord.email)
          }

          request.app.accountRecreated = true
          return db.deleteAccount(emailRecord)
        }

        function checkAccountError (err) {
          if (err.errno === error.ERRNO.ACCOUNT_UNKNOWN) {
            // Even though the email is not on the account table, it could be on the emails table.
            // Delete the unverified secondary email if it exists and proceed with account creation.
            return deleteSecondaryEmailIfUnverified()
          }

          throw err
        }

        function deleteSecondaryEmailIfUnverified() {
          return db.getSecondaryEmail(email)
            .then((secondaryEmailRecord) => {
              // Currently, users can not create an account from a verified
              // secondary email address
              if (secondaryEmailRecord.isVerified) {
                throw error.verifiedSecondaryEmailAlreadyExists()
              }

              return db.deleteEmail(secondaryEmailRecord.uid, secondaryEmailRecord.email)
            })
            .catch((err) => {
              if (err.errno !== error.ERRNO.SECONDARY_EMAIL_UNKNOWN) {
                throw err
              }
            })
        }

        function setMetricsFlowCompleteSignal () {
          let flowCompleteSignal
          if (service === 'sync') {
            flowCompleteSignal = 'account.signed'
          } else {
            flowCompleteSignal = 'account.verified'
          }
          request.setMetricsFlowCompleteSignal(flowCompleteSignal)

          return P.resolve()
        }
        function generateRandomValues() {
          return random.hex(16, 32)
            .then(hexes => {
              emailCode = hexes[0]
              tokenVerificationId = emailCode
              authSalt = hexes[1]
            })
        }

        function createPassword () {
          password = new Password(authPW, authSalt, config.verifierVersion)
          return password.verifyHash()
            .then(
              function (result) {
                verifyHash = result
              }
            )
        }

        function createAccount () {
          if (! locale) {
            // We're seeing a surprising number of accounts created
            // without a proper locale. Log details to help debug this.
            log.info({
              op: 'account.create.emptyLocale',
              email: email,
              locale: locale,
              agent: userAgentString
            })
          }

          return random.hex(32, 32)
          .then(hexes => db.createAccount({
            uid: uuid.v4('binary').toString('hex'),
            createdAt: Date.now(),
            email: email,
            emailCode: emailCode,
            emailVerified: preVerified,
            kA: hexes[0],
            wrapWrapKb: hexes[1],
            accountResetToken: null,
            passwordForgotToken: null,
            authSalt: authSalt,
            verifierVersion: password.version,
            verifyHash: verifyHash,
            verifierSetAt: Date.now(),
            locale: locale
          }))
          .then(
            function (result) {
              account = result

              return request.emitMetricsEvent('account.created', {
                uid: account.uid
              })
            }
          )
          .then(
            function () {
              if (account.emailVerified) {
                return log.notifyAttachedServices('verified', request, {
                  email: account.email,
                  uid: account.uid,
                  locale: account.locale,
                  marketingOptIn: marketingOptIn,
                })
              } else if (marketingOptIn) {
                return marketingCache.set(account.uid, true)
                  .catch(err => log.error({
                    op: 'marketingCache.set',
                    err: err,
                    uid: account.uid
                  }))
              }
            }
          )
          .then(
            function () {
              if (service === 'sync') {
                return log.notifyAttachedServices('login', request, {
                  service: 'sync',
                  uid: account.uid,
                  email: account.email,
                  deviceCount: 1,
                  userAgent: request.headers['user-agent']
                })
              }
            }
          )
        }

        function createSessionToken () {
          // Verified sessions should only be created for preverified accounts.
          if (preVerified) {
            tokenVerificationId = undefined
          }

          return db.createSessionToken({
            uid: account.uid,
            email: account.email,
            emailCode: account.emailCode,
            emailVerified: account.emailVerified,
            verifierSetAt: account.verifierSetAt,
            mustVerify: requestHelper.wantsKeys(request),
            tokenVerificationId: tokenVerificationId
          }, userAgentString)
            .then(
              function (result) {
                sessionToken = result
                return request.stashMetricsContext(sessionToken)
              }
            )
            .then(
              function () {
                // There is no session token when we emit account.verified
                // so stash the data against a synthesized "token" instead.
                return request.stashMetricsContext({
                  uid: account.uid,
                  id: account.emailCode
                })
              }
            )
        }

        function sendVerifyCode () {
          if (! account.emailVerified) {
            return getGeoData(ip)
              .then(function (geoData) {
                mailer.sendVerifyCode([], account, {
                  code: account.emailCode,
                  service: form.service || query.service,
                  redirectTo: form.redirectTo,
                  resume: form.resume,
                  acceptLanguage: request.app.acceptLanguage,
                  flowId: flowId,
                  flowBeginTime: flowBeginTime,
                  ip: ip,
                  location: geoData.location,
                  uaBrowser: sessionToken.uaBrowser,
                  uaBrowserVersion: sessionToken.uaBrowserVersion,
                  uaOS: sessionToken.uaOS,
                  uaOSVersion: sessionToken.uaOSVersion,
                  uaDeviceType: sessionToken.uaDeviceType
                })
                  .then(function () {
                    // only create reminder if sendVerifyCode succeeds
                    verificationReminder.create({
                      uid: account.uid
                    }).catch(function (err) {
                      log.error({op: 'Account.verificationReminder.create', err: err})
                    })

                    if (tokenVerificationId) {
                      // Log server-side metrics for confirming verification rates
                      log.info({
                        op: 'account.create.confirm.start',
                        uid: account.uid,
                        tokenVerificationId: tokenVerificationId
                      })
                    }
                  })
                  .catch(function (err) {
                    log.error({op: 'mailer.sendVerifyCode.1', err: err})

                    if (tokenVerificationId) {
                      // Log possible email bounce, used for confirming verification rates
                      log.error({
                        op: 'account.create.confirm.error',
                        uid: account.uid,
                        err: err,
                        tokenVerificationId: tokenVerificationId
                      })
                    }
                  })
              })
          }
        }

        function createKeyFetchToken () {
          if (requestHelper.wantsKeys(request)) {
            return password.unwrap(account.wrapWrapKb)
              .then(
                function (wrapKb) {
                  return db.createKeyFetchToken({
                    uid: account.uid,
                    kA: account.kA,
                    wrapKb: wrapKb,
                    emailVerified: account.emailVerified,
                    tokenVerificationId: tokenVerificationId
                  })
                }
              )
              .then(
                function (result) {
                  keyFetchToken = result
                  return request.stashMetricsContext(keyFetchToken)
                }
              )
          }
        }

        function recordSecurityEvent() {
          db.securityEvent({
            name: 'account.create',
            uid: account.uid,
            ipAddr: request.app.clientAddress,
            tokenId: sessionToken.tokenId
          })
        }

        function createResponse () {
          const response = {
            uid: account.uid,
            sessionToken: sessionToken.data,
            authAt: sessionToken.lastAuthAt()
          }

          if (keyFetchToken) {
            response.keyFetchToken = keyFetchToken.data
          }

          return P.resolve(response)
        }
      }
    },
    {
      method: 'POST',
      path: '/account/login',
      config: {
        validate: {
          query: {
            keys: isA.boolean().optional(),
            service: validators.service
          },
          payload: {
            email: validators.email().required(),
            authPW: isA.string().min(64).max(64).regex(HEX_STRING).required(),
            service: validators.service,
            redirectTo: isA.string().uri().optional(),
            resume: isA.string().optional(),
            reason: isA.string().max(16).optional(),
            unblockCode: isA.string().regex(BASE_36).length(unblockCodeLen).optional(),
            metricsContext: METRICS_CONTEXT_SCHEMA
          }
        },
        response: {
          schema: {
            uid: isA.string().regex(HEX_STRING).required(),
            sessionToken: isA.string().regex(HEX_STRING).required(),
            keyFetchToken: isA.string().regex(HEX_STRING).optional(),
            verificationMethod: isA.string().optional(),
            verificationReason: isA.string().optional(),
            verified: isA.boolean().required(),
            authAt: isA.number().integer()
          }
        }
      },
      handler: function (request, reply) {
        log.begin('Account.login', request)

        const form = request.payload
        const email = form.email
        const authPW = form.authPW
        const service = request.payload.service || request.query.service
        const redirectTo = request.payload.redirectTo
        const resume = request.payload.resume
        const ip = request.app.clientAddress
        const requestNow = Date.now()

        let needsVerificationId = true
        let emailRecord, sessions, sessionToken, keyFetchToken, mustVerifySession, doSigninConfirmation,
          unblockCode, customsErr, didSigninUnblock, tokenVerificationId

        let securityEventRecency = Infinity, securityEventVerified = false

        request.validateMetricsContext()

        // Store flowId and flowBeginTime to send in email
        let flowId, flowBeginTime
        if (request.payload.metricsContext) {
          flowId = request.payload.metricsContext.flowId
          flowBeginTime = request.payload.metricsContext.flowBeginTime
        }

        checkIsBlockForced()
          .then(() => customs.check(request, email, 'accountLogin'))
          .catch(extractUnblockCode)
          .then(readEmailRecord)
          .then(checkUnblockCode)
          .then(checkSecurityHistory)
          .then(checkEmailAndPassword)
          .then(checkNumberOfActiveSessions)
          .then(createSessionToken)
          .then(createKeyFetchToken)
          .then(emitSyncLoginEvent)
          .then(sendVerifyAccountEmail)
          .then(sendNewDeviceLoginNotification)
          .then(sendVerifyLoginEmail)
          .then(recordSecurityEvent)
          .then(createResponse)
          .then(reply, reply)

        function checkIsBlockForced () {
          // For testing purposes, some email addresses are forced
          // to go through signin unblock on every login attempt.
          const forced = config.signinUnblock && config.signinUnblock.forcedEmailAddresses

          if (forced && forced.test(email)) {
            return P.reject(error.requestBlocked(true))
          }

          return P.resolve()
        }

        function extractUnblockCode (e) {
          // If it's a customs-related error...
          if (e.errno === error.ERRNO.REQUEST_BLOCKED || e.errno === error.ERRNO.THROTTLED) {
            return request.emitMetricsEvent('account.login.blocked')
              .then(() => {
                var verificationMethod = e.output.payload.verificationMethod
                // ...and if they can verify their way around it,
                // then extract any unblockCode from the request.
                // We'll re-throw the error later if the code is invalid.
                if (verificationMethod === 'email-captcha') {
                  unblockCode = request.payload.unblockCode
                  if (unblockCode) {
                    unblockCode = unblockCode.toUpperCase()
                  }
                  customsErr = e
                  return
                }
                throw e
              })
          }
          // Any other errors are propagated back to the user.
          throw e
        }

        function checkSecondaryEmail() {
          log.trace({op: 'Account.login.checkSecondaryEmail'})
          if (! features.isSecondaryEmailEnabled(email)) {
            return P.resolve()
          }

          // Currently, we only allow emails on the account table to log a user in.
          // If the email being used is a secondary email, fail fast and let the user
          // know that this can not be used to login.
          return db.getSecondaryEmail(email)
            .then((email) => {
              if (email) {
                throw error.cannotLoginWithSecondaryEmail()
              }
            }, (err) => {
              // No secondary email exists for this, continue with the regular login flow
              if (err.errno === error.ERRNO.SECONDARY_EMAIL_UNKNOWN) {
                log.trace({op: 'Account.login.checkSecondaryEmail.noconflict'})
                return P.resolve()
              }
              throw err
            })
        }

        function readEmailRecord () {
          return db.emailRecord(email)
            .then(
              function (result) {

                // If the incorrect email case is used, the password check cannot possibly succeed,
                // and the client will retry automatically with the correct capitalization.
                // Don't tell customs-server this was a failed login attempt, to avoid penalizing the user twice.
                if (email !== result.email) {
                  throw error.incorrectPassword(result.email, email)
                }

                emailRecord = result
              },
              function (err) {
                if (err.errno === error.ERRNO.ACCOUNT_UNKNOWN) {

                  // Check to see if this email exists on the emails table. `checkSecondaryEmail` throws
                  // a custom error if user is attempting to login with a secondary email, otherwise we
                  // flag the request and throw account unknown error.
                  return checkSecondaryEmail()
                    .then(() => {
                      customs.flag(request.app.clientAddress, {
                        email: email,
                        errno: err.errno
                      })
                      // We rate-limit attempts to check whether an account exists, so
                      // we have to be careful to re-throw any customs-server errors here.
                      // We also have to be careful not to leak info about whether the account
                      // existed, for example by saying sign-in unblock is unavailable on
                      // accounts that don't exist. We pass a fake uid into the feature-flag
                      // test to mask whether the account existed.
                      if (customsErr) {
                        throw customsErr
                      }

                      throw err
                    })
                }
                throw err
              }
            )
        }

        function checkUnblockCode() {
          if (unblockCode) {
            return db.consumeUnblockCode(emailRecord.uid, unblockCode)
              .then(
                (code) => {
                  if (requestNow - code.createdAt > unblockCodeLifetime) {
                    log.info({
                      op: 'Account.login.unblockCode.expired',
                      uid: emailRecord.uid
                    })
                    throw error.invalidUnblockCode()
                  }
                  didSigninUnblock = true
                  return request.emitMetricsEvent('account.login.confirmedUnblockCode')
                }
              )
              .catch(
                (err) => {
                  if (err.errno === error.ERRNO.INVALID_UNBLOCK_CODE) {
                    return request.emitMetricsEvent('account.login.invalidUnblockCode')
                      .then(() => {
                        customs.flag(request.app.clientAddress, {
                          email: email,
                          errno: err.errno
                        })
                        throw err
                      })
                  }
                  throw err
                }
              )
          }
          if (! didSigninUnblock && customsErr) {
            throw customsErr
          }
        }

        function checkSecurityHistory () {
          return db.securityEvents({
            uid: emailRecord.uid,
            ipAddr: request.app.clientAddress
          })
            .then(
              (events) => {
                if (events.length > 0) {
                  let latest = 0
                  events.forEach(function(ev) {
                    if (ev.verified) {
                      securityEventVerified = true
                      if (ev.createdAt > latest) {
                        latest = ev.createdAt
                      }
                    }
                  })
                  if (securityEventVerified) {
                    securityEventRecency = requestNow - latest
                    let coarseRecency
                    if (securityEventRecency < MS_ONE_DAY) {
                      coarseRecency = 'day'
                    } else if (securityEventRecency < MS_ONE_WEEK) {
                      coarseRecency = 'week'
                    } else if (securityEventRecency < MS_ONE_MONTH) {
                      coarseRecency = 'month'
                    } else {
                      coarseRecency = 'old'
                    }

                    log.info({
                      op: 'Account.history.verified',
                      uid: emailRecord.uid,
                      events: events.length,
                      recency: coarseRecency
                    })
                  } else {
                    log.info({
                      op: 'Account.history.unverified',
                      uid: emailRecord.uid,
                      events: events.length
                    })
                  }
                }
              },
              function (err) {
                // for now, security events are purely for metrics
                // so errors shouldn't stop the login attempt
                log.error({
                  op: 'Account.history.error',
                  err: err,
                  uid: emailRecord.uid
                })
              }
            )
        }

        function checkEmailAndPassword () {
          // All sessions are considered unverified by default.
          needsVerificationId = true

          // However! To help simplify the login flow, we can use some heuristics to
          // decide whether to consider the session pre-verified.  Some accounts
          // get excluded from this process, e.g. testing accounts where we want
          // to know for sure what flow they're going to see.
          if (! forceTokenVerification(request, emailRecord)) {
            if (skipTokenVerification(request, emailRecord)) {
              needsVerificationId = false
            }
          }

          // If they just went through the sigin-unblock flow, they have already verified their email.
          // We don't need to force them to do that again, just make a verified session.
          if (didSigninUnblock) {
            needsVerificationId = false
          }

          // If the request wants keys, the user *must* confirm their login session before they
          // can actually use it.  If they dont want keys, they don't *have* to verify their
          // their session, but we still create it with a non-null tokenVerificationId, so it will
          // still be considered unverified.  This prevents the session from being used for sync
          // unless the user explicitly requests us to resend the confirmation email, and completes it.
          mustVerifySession = needsVerificationId && requestHelper.wantsKeys(request)

          // If the email itself is unverified, we'll re-send the "verify your account email" and
          // that will suffice to confirm the sign-in.  No need for a separate confirmation email.
          doSigninConfirmation = mustVerifySession && emailRecord.emailVerified

          let flowCompleteSignal
          if (service === 'sync') {
            flowCompleteSignal = 'account.signed'
          } else if (doSigninConfirmation) {
            flowCompleteSignal = 'account.confirmed'
          } else {
            flowCompleteSignal = 'account.login'
          }
          request.setMetricsFlowCompleteSignal(flowCompleteSignal)

          return checkPassword(emailRecord, authPW, request.app.clientAddress)
            .then(
              function (match) {
                if (! match) {
                  throw error.incorrectPassword(emailRecord.email, email)
                }

                return request.emitMetricsEvent('account.login', {
                  uid: emailRecord.uid
                })
              }
            )
        }

        function forceTokenVerification (request, account) {
          // If there was anything suspicious about the request,
          // we should force token verification.
          if (request.app.isSuspiciousRequest) {
            return true
          }
          // If it's an email address used for testing etc,
          // we should force token verification.
          if (config.signinConfirmation) {
            if (config.signinConfirmation.forcedEmailAddresses) {
              if (config.signinConfirmation.forcedEmailAddresses.test(account.email)) {
                return true
              }
            }
          }
          return false
        }

        function skipTokenVerification (request, account) {
          // If they're logging in from an IP address on which they recently did
          // another, successfully-verified login, then we can consider this one
          // verified as well without going through the loop again.
          const allowedRecency = config.securityHistory.ipProfiling.allowedRecency || 0
          if (securityEventVerified && securityEventRecency < allowedRecency) {
            log.info({
              op: 'Account.ipprofiling.seenAddress',
              uid: account.uid
            })
            return true
          }

          // If the account was recently created, don't make the user
          // confirm sign-in for a configurable amount of time. This will reduce
          // the friction of a user adding a second device.
          const skipForNewAccounts = config.signinConfirmation.skipForNewAccounts
          if (skipForNewAccounts && skipForNewAccounts.enabled) {
            const accountAge = requestNow - account.createdAt
            if (accountAge <= skipForNewAccounts.maxAge) {
              log.info({
                op: 'account.signin.confirm.bypass.age',
                uid: account.uid
              })
              return true
            }
          }

          return false
        }

        function checkNumberOfActiveSessions () {
          return db.sessions(emailRecord.uid)
            .then(
              function (s) {
                sessions = s
                if (sessions.length > MAX_ACTIVE_SESSIONS) {
                  // There's no spec-compliant way to error out
                  // as a result of having too many active sessions.
                  // For now, just log metrics about it.
                  log.error({
                    op: 'Account.login',
                    uid: emailRecord.uid,
                    userAgent: request.headers['user-agent'],
                    numSessions: sessions.length
                  })
                }
              }
            )
        }

        function createSessionToken () {
          return P.resolve()
            .then(() => {
              if (needsVerificationId) {
                return random.hex(16).then(hex => {
                  tokenVerificationId = hex
                })
              }
            })
            .then(() => {
              const sessionTokenOptions = {
                uid: emailRecord.uid,
                email: emailRecord.email,
                emailCode: emailRecord.emailCode,
                emailVerified: emailRecord.emailVerified,
                verifierSetAt: emailRecord.verifierSetAt,
                mustVerify: mustVerifySession,
                tokenVerificationId: tokenVerificationId
              }

              return db.createSessionToken(sessionTokenOptions, request.headers['user-agent'])
            })
            .then(
              function (result) {
                sessionToken = result
                return request.stashMetricsContext(sessionToken)
              }
            )
            .then(
              function () {
                if (doSigninConfirmation) {
                  // There is no session token when we emit account.confirmed
                  // so stash the data against a synthesized "token" instead.
                  return request.stashMetricsContext({
                    uid: emailRecord.uid,
                    id: tokenVerificationId
                  })
                }
              }
            )
        }

        function createKeyFetchToken() {
          if (requestHelper.wantsKeys(request)) {
            var password = new Password(
              authPW,
              emailRecord.authSalt,
              emailRecord.verifierVersion
            )

            return password.unwrap(emailRecord.wrapWrapKb)
              .then(
                function (wrapKb) {
                  return db.createKeyFetchToken({
                    uid: emailRecord.uid,
                    kA: emailRecord.kA,
                    wrapKb: wrapKb,
                    emailVerified: emailRecord.emailVerified,
                    tokenVerificationId: tokenVerificationId
                  })
                  .then(
                    function (result) {
                      keyFetchToken = result
                      return request.stashMetricsContext(keyFetchToken)
                    }
                  )
                }
              )
          }
        }

        function emitSyncLoginEvent () {
          if (service === 'sync' && request.payload.reason === 'signin') {
            return log.notifyAttachedServices('login', request, {
              service: 'sync',
              uid: emailRecord.uid,
              email: emailRecord.email,
              deviceCount: sessions.length,
              userAgent: request.headers['user-agent']
            })
          }
        }

        function sendVerifyAccountEmail() {
          if (! emailRecord.emailVerified) {
            if (didSigninUnblock) {
              log.info({
                op: 'Account.login.unverified.unblocked',
                uid: emailRecord.uid
              })
            }

            // Only use tokenVerificationId if it is set, otherwise use the corresponding email code
            // This covers the cases where sign-in confirmation is disabled or not needed.
            var emailCode = tokenVerificationId ? tokenVerificationId : emailRecord.emailCode

            return getGeoData(ip)
              .then(
                function (geoData) {
                  return mailer.sendVerifyCode([], emailRecord, {
                    code: emailCode,
                    service: service,
                    redirectTo: redirectTo,
                    resume: resume,
                    acceptLanguage: request.app.acceptLanguage,
                    flowId: flowId,
                    flowBeginTime: flowBeginTime,
                    ip: ip,
                    location: geoData.location,
                    uaBrowser: sessionToken.uaBrowser,
                    uaBrowserVersion: sessionToken.uaBrowserVersion,
                    uaOS: sessionToken.uaOS,
                    uaOSVersion: sessionToken.uaOSVersion,
                    uaDeviceType: sessionToken.uaDeviceType
                  })
                }
              )
              .then(() => request.emitMetricsEvent('email.verification.sent'))
          }
        }

        function sendNewDeviceLoginNotification() {
          // New device notification emails should only be sent when requesting keys.
          // They're not sent if performing a sign-in confirmation
          // (in which case you get the sign-in confirmation email)
          // or if the account is unverified (in which case
          // content-server triggers a resend of the account verification email)
          var shouldSendNewDeviceLoginEmail = config.newLoginNotificationEnabled
            && requestHelper.wantsKeys(request)
            && ! doSigninConfirmation
            && emailRecord.emailVerified
          if (shouldSendNewDeviceLoginEmail) {
            return P.all([getGeoData(ip), db.accountEmails(sessionToken.uid)])
              .spread((geoData, emails) => {
                // New device notifications are always sent to the primary account email (emailRecord.email)
                // and CCed to all secondary email if enabled.
                mailer.sendNewDeviceLoginNotification(
                  emails,
                  emailRecord,
                  {
                    acceptLanguage: request.app.acceptLanguage,
                    flowId: flowId,
                    flowBeginTime: flowBeginTime,
                    ip: ip,
                    location: geoData.location,
                    timeZone: geoData.timeZone,
                    uaBrowser: sessionToken.uaBrowser,
                    uaBrowserVersion: sessionToken.uaBrowserVersion,
                    uaOS: sessionToken.uaOS,
                    uaOSVersion: sessionToken.uaOSVersion,
                    uaDeviceType: sessionToken.uaDeviceType
                  }
                )
                  .catch(e => {
                    // If we couldn't email them, no big deal. Log
                    // and pretend everything worked.
                    log.trace({
                      op: 'Account.login.sendNewDeviceLoginNotification.error',
                      error: e
                    })
                  })
              })
          }
        }

        function sendVerifyLoginEmail() {
          if (doSigninConfirmation) {
            log.info({
              op: 'account.signin.confirm.start',
              uid: emailRecord.uid,
              tokenVerificationId: tokenVerificationId
            })

            return P.all([getGeoData(ip), db.accountEmails(sessionToken.uid)])
              .spread((geoData, emails) => {
                return mailer.sendVerifyLoginEmail(
                  emails,
                  emailRecord,
                  {
                    acceptLanguage: request.app.acceptLanguage,
                    code: tokenVerificationId,
                    flowId: flowId,
                    flowBeginTime: flowBeginTime,
                    ip: ip,
                    location: geoData.location,
                    redirectTo: redirectTo,
                    resume: resume,
                    service: service,
                    timeZone: geoData.timeZone,
                    uaBrowser: sessionToken.uaBrowser,
                    uaBrowserVersion: sessionToken.uaBrowserVersion,
                    uaOS: sessionToken.uaOS,
                    uaOSVersion: sessionToken.uaOSVersion,
                    uaDeviceType: sessionToken.uaDeviceType
                  }
                )
              })
              .then(() => request.emitMetricsEvent('email.confirmation.sent'))
          }
        }

        function recordSecurityEvent() {
          db.securityEvent({
            name: 'account.login',
            uid: emailRecord.uid,
            ipAddr: request.app.clientAddress,
            tokenId: sessionToken && sessionToken.tokenId
          })
        }

        function createResponse () {
          var response = {
            uid: sessionToken.uid,
            sessionToken: sessionToken.data,
            verified: sessionToken.emailVerified,
            authAt: sessionToken.lastAuthAt()
          }


          if (! requestHelper.wantsKeys(request)) {
            return P.resolve(response)
          }

          response.keyFetchToken = keyFetchToken.data

          if (! emailRecord.emailVerified) {
            response.verified = false
            response.verificationMethod = 'email'
            response.verificationReason = 'signup'
          } else if (doSigninConfirmation) {
            response.verified = false
            response.verificationMethod = 'email'
            response.verificationReason = 'login'
          }
          return P.resolve(response)
        }
      }
    },
    {
      method: 'GET',
      path: '/account/status',
      config: {
        auth: {
          mode: 'optional',
          strategy: 'sessionToken'
        },
        validate: {
          query: {
            uid: isA.string().min(32).max(32).regex(HEX_STRING)
          }
        }
      },
      handler: function (request, reply) {
        var sessionToken = request.auth.credentials
        if (sessionToken) {
          reply({ exists: true, locale: sessionToken.locale })
        }
        else if (request.query.uid) {
          var uid = request.query.uid
          db.account(uid)
            .then(
              function (account) {
                reply({ exists: true })
              },
              function (err) {
                if (err.errno === error.ERRNO.ACCOUNT_UNKNOWN) {
                  return reply({ exists: false })
                }
                reply(err)
              }
            )
        }
        else {
          reply(error.missingRequestParameter('uid'))
        }
      }
    },
    {
      method: 'POST',
      path: '/account/status',
      config: {
        validate: {
          payload: {
            email: validators.email().required()
          }
        },
        response: {
          schema: {
            exists: isA.boolean().required()
          }
        }
      },
      handler: function (request, reply) {
        var email = request.payload.email

        customs.check(
          request,
          email,
          'accountStatusCheck')
          .then(
            db.accountExists.bind(db, email)
          )
          .then(
            function (exist) {
              reply({
                exists: exist
              })
            },
            function (err) {
              if (err.errno === error.ERRNO.ACCOUNT_UNKNOWN) {
                return reply({ exists: false })
              }
              reply(err)
            }
          )
      }
    },
    {
      method: 'GET',
      path: '/account/profile',
      config: {
        auth: {
          mode: 'optional',
          strategies: [
            'sessionToken',
            'oauthToken'
          ]
        }
      },
      handler: function (request, reply) {
        var auth = request.auth
        var uid
        if (auth.strategy === 'sessionToken') {
          uid = auth.credentials.uid
        } else {
          uid = auth.credentials.user
        }
        function hasProfileItemScope(item) {
          if (auth.strategy === 'sessionToken') {
            return true
          }
          var scopes = auth.credentials.scope
          for (var i = 0; i < scopes.length; i++) {
            if (scopes[i] === 'profile') {
              return true
            }
            if (scopes[i] === 'profile:write') {
              return true
            }
            if (scopes[i] === 'profile:' + item) {
              return true
            }
            if (scopes[i] === 'profile:' + item + ':write') {
              return true
            }
          }
          return false
        }
        db.account(uid)
          .then(
            function (account) {
              reply({
                email: hasProfileItemScope('email') ? account.email : undefined,
                locale: hasProfileItemScope('locale') ? account.locale : undefined
              })
            },
            function (err) {
              reply(err)
            }
          )
      }
    },
    {
      method: 'GET',
      path: '/account/keys',
      config: {
        auth: {
          strategy: 'keyFetchTokenWithVerificationStatus'
        },
        response: {
          schema: {
            bundle: isA.string().regex(HEX_STRING)
          }
        }
      },
      handler: function accountKeys(request, reply) {
        log.begin('Account.keys', request)
        var keyFetchToken = request.auth.credentials

        var verified = keyFetchToken.tokenVerified && keyFetchToken.emailVerified
        if (! verified) {
          // don't delete the token on use until the account is verified
          return reply(error.unverifiedAccount())
        }
        db.deleteKeyFetchToken(keyFetchToken)
          .then(
            function () {
              return request.emitMetricsEvent('account.keyfetch', {
                uid: keyFetchToken.uid
              })
            }
          )
          .then(
            function () {
              return {
                bundle: keyFetchToken.keyBundle
              }
            }
          )
          .then(reply, reply)
      }
    },
    {
      method: 'GET',
      path: '/recovery_email/check_can_add_secondary_address',
      config: {
        auth: {
          strategy: 'sessionTokenWithVerificationStatus'
        }
      },
      handler (request, reply) {
        log.begin('Account.RecoveryEmailEnabled', request)
        const sessionToken = request.auth.credentials
        let enabled = false

        // Secondary emails are enabled if feature is enabled for user and they are in a verified session
        if (features.isSecondaryEmailEnabled(sessionToken.email) && sessionToken.tokenVerified) {
          enabled = true
        }

        return reply({ok: enabled})
      }
    },
    {
      method: 'GET',
      path: '/recovery_email/status',
      config: {
        auth: {
          strategy: 'sessionTokenWithVerificationStatus'
        },
        validate: {
          query: {
            reason: isA.string().max(16).optional()
          }
        },
        response: {
          schema: {
            // There's code in the handler that checks for a valid email,
            // no point adding overhead by doing it again here.
            email: isA.string().required(),
            verified: isA.boolean().required(),
            sessionVerified: isA.boolean().optional(),
            emailVerified: isA.boolean().optional()
          }
        }
      },
      handler: function (request, reply) {
        log.begin('Account.RecoveryEmailStatus', request)
        var sessionToken = request.auth.credentials
        if (request.query && request.query.reason === 'push') {
          // log to the push namespace that account was verified via push
          log.info({
            op: 'push.pushToDevices',
            name: 'recovery_email_reason.push'
          })
        }

        cleanUpIfAccountInvalid()
          .then(createResponse)
          .then(reply, reply)

        function cleanUpIfAccountInvalid() {
          // Some historical bugs mean we've allowed creation
          // of accounts with invalid email addresses. These
          // can never be verified, so the best we can do is
          // to delete them so the browser will stop polling.
          if (! sessionToken.emailVerified) {
            if (! validators.isValidEmailAddress(sessionToken.email)) {
              return db.deleteAccount(sessionToken)
                .then(
                  function () {
                    // Act as though we deleted the account asynchronously
                    // and caused the sessionToken to become invalid.
                    throw error.invalidToken('This account was invalid and has been deleted')
                  }
                )
            }
          }
          return P.resolve()
        }

        function createResponse() {

          var sessionVerified = sessionToken.tokenVerified
          var emailVerified = !! sessionToken.emailVerified

          // For backwards-compatibility reasons, the reported verification status
          // depends on whether the sessionToken was created with keys=true and
          // whether it has subsequently been verified.  If it was created with
          // keys=true then we musn't say verified=true until the session itself
          // has been verified.  Otherwise, desktop clients will attempt to use
          // an unverified session to connect to sync, and produce a very confusing
          // user experience.
          var isVerified = emailVerified
          if (sessionToken.mustVerify) {
            isVerified = isVerified && sessionVerified
          }

          return {
            email: sessionToken.email,
            verified: isVerified,
            sessionVerified: sessionVerified,
            emailVerified: emailVerified
          }
        }
      }
    },
    {
      method: 'POST',
      path: '/recovery_email/resend_code',
      config: {
        auth: {
          strategy: 'sessionTokenWithVerificationStatus'
        },
        validate: {
          query: {
            service: validators.service
          },
          payload: {
            email: validators.email().optional(),
            service: validators.service,
            redirectTo: validators.redirectTo(config.smtp.redirectDomain).optional(),
            resume: isA.string().max(2048).optional(),
            metricsContext: METRICS_CONTEXT_SCHEMA
          }
        }
      },
      handler: function (request, reply) {
        log.begin('Account.RecoveryEmailResend', request)
        const email = request.payload.email
        const sessionToken = request.auth.credentials
        const service = request.payload.service || request.query.service

        // This endpoint can verify multiple types of codes, set these values once it
        // is known what is being verified.
        let code
        let verifyFunction
        let event
        let emails = []

        // Return immediately if this session or token is already verified. Only exception
        // is if the email param has been specified, which means that this is
        // a request to verify a secondary email.
        if (sessionToken.emailVerified && sessionToken.tokenVerified && ! email) {
          return reply({})
        }

        customs.check(request, sessionToken.email, 'recoveryEmailResendCode')
          .then(setVerifyCode)
          .then(setVerifyFunction)
          .then(() => {
            const mailerOpts = {
              code: code,
              service: service,
              timestamp: Date.now(),
              redirectTo: request.payload.redirectTo,
              resume: request.payload.resume,
              acceptLanguage: request.app.acceptLanguage,
              uaBrowser: sessionToken.uaBrowser,
              uaBrowserVersion: sessionToken.uaBrowserVersion,
              uaOS: sessionToken.uaOS,
              uaOSVersion: sessionToken.uaOSVersion,
              uaDeviceType: sessionToken.uaDeviceType
            }

            return verifyFunction(emails, sessionToken, mailerOpts)
          })
          .then(() => request.emitMetricsEvent(`email.${event}.resent`))
          .then(
            () => reply({}),
            reply
          )

        function setVerifyCode() {
          return db.accountEmails(sessionToken.uid)
            .then((emailData) => {
              if (email) {
                // If an email address is specified in payload, this is a request to verify
                // a secondary email. This should return the corresponding email code for verification.
                let emailVerified = false
                emailData.some((userEmail) => {
                  if (userEmail.normalizedEmail === email.toLowerCase()) {
                    code = userEmail.emailCode
                    emailVerified = userEmail.isVerified
                    emails = [userEmail]
                    return true
                  }
                })

                // Don't resend code for already verified emails
                if (emailVerified) {
                  return reply({})
                }
              } else if (sessionToken.tokenVerificationId) {
                emails = emailData
                code = sessionToken.tokenVerificationId
              } else {
                code = sessionToken.emailCode
              }
            })
        }

        function setVerifyFunction() {
          if (email) {
            verifyFunction = mailer.sendVerifySecondaryEmail
            event = 'verification_email'
          } else if (! sessionToken.emailVerified) {
            verifyFunction = mailer.sendVerifyCode
            event = 'verification'
          } else {
            verifyFunction = mailer.sendVerifyLoginEmail
            event = 'confirmation'
          }
        }
      }
    },
    {
      method: 'POST',
      path: '/recovery_email/verify_code',
      config: {
        validate: {
          query: {
            service: validators.service,
            reminder: isA.string().max(32).alphanum().optional(),
            type: isA.string().max(32).alphanum().optional()
          },
          payload: {
            uid: isA.string().max(32).regex(HEX_STRING).required(),
            code: isA.string().min(32).max(32).regex(HEX_STRING).required(),
            service: validators.service,
            reminder: isA.string().max(32).alphanum().optional(),
            type: isA.string().max(32).alphanum().optional()
          }
        }
      },
      handler: function (request, reply) {
        const uid = request.payload.uid
        const code = request.payload.code
        const service = request.payload.service || request.query.service
        const reminder = request.payload.reminder || request.query.reminder
        const type = request.payload.type || request.query.type

        log.begin('Account.RecoveryEmailVerify', request)

        // verify_code because we don't know what type this is yet, but
        // we want to record right away before anything could fail, so
        // we can see in a flow that a user tried to verify, even if it
        // failed right away.
        request.emitMetricsEvent('email.verify_code.clicked')

        /**
         * Below is a summary of the verify_code flow. This flow is used to verify emails, sign-in and
         * account codes.
         *
         * 1) Check request against customs server, proceed if valid.
         *
         * 2) If type=`secondary` then this is an email code and verify it
         *    accordingly.
         *
         * 3) Otherwise attempt to verify code as sign-in code then account code.
         */
        return db.account(uid)
          .then((account) => {
            // This endpoint is not authenticated, so we need to look up
            // the target email address before we can check it with customs.
            return customs.check(request, account.email, 'recoveryEmailVerifyCode')
              .then(() => {
                return account
              })
          })
          .then((account) => {
            // Check if param `type` is specified and equal to `secondary`
            // If so, verify the secondary email and respond
            if (type && type === 'secondary' && features.isSecondaryEmailEnabled(account.email)) {
              let matchedEmail
              return db.accountEmails(account.uid)
                .then((emails) => {
                  const isEmailVerification = emails.some((email) => {
                    if (email.emailCode && (code === email.emailCode)) {
                      matchedEmail = email
                      log.info({
                        op: 'account.verifyEmail.secondary.started',
                        uid: uid,
                        code: request.payload.code
                      })
                      return true
                    }
                  })

                  // Attempt to verify email token not associated with account
                  if (! isEmailVerification) {
                    throw error.invalidVerificationCode()
                  }

                  // User is attempting to verify a secondary email that has already been verified.
                  // Silently succeed and don't send post verification email.
                  if (matchedEmail.isVerified) {
                    log.info({
                      op: 'account.verifyEmail.secondary.already-verified',
                      uid: uid,
                      code: request.payload.code
                    })
                    return P.resolve()
                  }

                  return db.verifyEmail(account, code)
                    .then(() => {
                      log.info({
                        op: 'account.verifyEmail.secondary.confirmed',
                        uid: uid,
                        code: request.payload.code
                      })
                      return mailer.sendPostVerifySecondaryEmail(
                        [],
                        account,
                        {
                          acceptLanguage: request.app.acceptLanguage,
                          secondaryEmail: matchedEmail.email
                        })
                    })
                })
            } else {
              const isAccountVerification = butil.buffersAreEqual(code, account.emailCode)
              let device

              return db.deviceFromTokenVerificationId(uid, code)
                .then(function (associatedDevice) {
                  device = associatedDevice
                }, function (err) {
                  if (err.errno !== error.ERRNO.DEVICE_UNKNOWN) {
                    log.error({
                      op: 'Account.RecoveryEmailVerify',
                      err: err,
                      uid: uid,
                      code: code
                    })
                  }
                })
                .then(function () {
                  /**
                   * Logic for account and token verification
                   *
                   * 1) Attempt to use code as tokenVerificationId to verify session.
                   *
                   * 2) An error is thrown if tokenVerificationId does not exist (check to see if email
                   *    verification code) or the tokenVerificationId does not correlate to the
                   *    account uid (damaged linked/spoofed account)
                   *
                   * 3) Verify account email if not already verified.
                   */
                  return db.verifyTokens(code, account)
                    .then(function () {
                      if (! isAccountVerification) {
                        // Don't log sign-in confirmation success for the account verification case
                        log.info({
                          op: 'account.signin.confirm.success',
                          uid: uid,
                          code: request.payload.code
                        })
                        request.emitMetricsEvent('account.confirmed', {
                          uid: uid
                        })
                        push.notifyUpdate(uid, 'accountConfirm')
                      }
                    })
                    .catch(function (err) {
                      if (err.errno === error.ERRNO.INVALID_VERIFICATION_CODE && isAccountVerification) {
                        // The code is just for the account, not for any sessions
                        return true
                      }
                      log.error({
                        op: 'account.signin.confirm.invalid',
                        uid: uid,
                        code: request.payload.code,
                        error: err
                      })
                      throw err
                    })
                    .then(function () {
                      if (device) {
                        push.notifyDeviceConnected(uid, device.name, device.id)
                      }
                    })
                    .then(function () {

                      // If the account is already verified, the link may have been
                      // for sign-in confirmation or they may have been clicking a
                      // stale link. Silently succeed.
                      if (account.emailVerified) {
                        return true
                      }

                      // Any matching code verifies the account
                      return db.verifyEmail(account, account.emailCode)
                        .then(function () {
                          return P.all([
                            marketingCache.get(account.uid)
                              .catch(err => {
                                log.error({
                                  op: 'marketingCache.get',
                                  err: err,
                                  uid: account.uid
                                })
                                return false
                              })
                              .then(optedIn => {
                                log.notifyAttachedServices('verified', request, {
                                  email: account.email,
                                  uid: account.uid,
                                  locale: account.locale,
                                  marketingOptIn: optedIn ? true : undefined
                                })
                              }),
                            request.emitMetricsEvent('account.verified', {
                              uid: uid
                            })
                          ])
                        })
                        .then(function () {
                          if (reminder === 'first' || reminder === 'second') {
                            // if verified using a known reminder
                            var reminderOp = 'account.verified_reminder.' + reminder

                            // log to the mailer namespace that account was verified via a reminder
                            log.info({
                              op: 'mailer.send',
                              name: reminderOp
                            })
                            return request.emitMetricsEvent('account.reminder', {
                              uid: uid
                            })
                          }
                        })
                        .then(function () {
                          // send a push notification to all devices that the account changed
                          push.notifyUpdate(uid, 'accountVerify')
                          // remove verification reminders
                          verificationReminder.delete({
                            uid: uid
                          }).catch(function (err) {
                            log.error({op: 'Account.RecoveryEmailVerify', err: err})
                          })
                        })
                        .then(function () {
                          // Our post-verification email is very specific to sync,
                          // so only send it if we're sure this is for sync.
                          if (service === 'sync') {
                            return mailer.sendPostVerifyEmail(
                              [],
                              account,
                              {
                                acceptLanguage: request.app.acceptLanguage
                              }
                            )
                          }
                        })
                    })
                })
            }
          })
          .then(
            function () {
              reply({})
            },
            reply
          )
      }
    },
    {
      method: 'GET',
      path: '/recovery_emails',
      config: {
        auth: {
          strategy: 'sessionToken'
        },
        response: {
          schema: isA.array().items(
            isA.object({
              verified: isA.boolean().required(),
              isPrimary: isA.boolean().required(),
              email: validators.email().required()
            }))
        }
      },
      handler: function (request, reply) {
        const sessionToken = request.auth.credentials
        const uid = sessionToken.uid

        log.begin('Account.RecoveryEmailEmails', request)

        if (! features.isSecondaryEmailEnabled(sessionToken.email)) {
          return reply(error.featureNotEnabled())
        }

        db.accountEmails(uid)
          .then(createResponse)
          .done(reply, reply)

        function createResponse(emails) {
          return emails.map((email) => {
            return {
              email: email.email,
              isPrimary: !! email.isPrimary,
              verified: !! email.isVerified
            }
          })
        }
      }
    },
    {
      method: 'POST',
      path: '/recovery_email',
      config: {
        auth: {
          strategy: 'sessionTokenWithVerificationStatus'
        },
        validate: {
          payload: {
            email: validators.email().required()
          }
        },
        response: {}
      },
      handler: function (request, reply) {
        const sessionToken = request.auth.credentials
        const uid = sessionToken.uid
        const primaryEmail = sessionToken.email
        const ip = request.app.clientAddress
        const email = request.payload.email
        const emailData = {
          email: email,
          normalizedEmail: email.toLowerCase(),
          isVerified: false,
          isPrimary: false,
          uid: uid
        }

        log.begin('Account.RecoveryEmailCreate', request)

        if (! features.isSecondaryEmailEnabled(primaryEmail)) {
          return reply(error.featureNotEnabled())
        }

        if (! sessionToken.emailVerified) {
          return reply(error.unverifiedAccount())
        }

        if (sessionToken.tokenVerificationId) {
          return reply(error.unverifiedSession())
        }

        if (sessionToken.email.toLowerCase() === email.toLowerCase()) {
          return reply(error.yourPrimaryEmailExists())
        }

        customs.check(request, primaryEmail, 'createEmail')
          .then(deleteAccountIfUnverified)
          .then(deleteSecondaryEmailIfUnverified)
          .then(generateRandomValues)
          .then(createEmail)
          .then(sendEmailVerification)
          .then(
            function () {
              reply({})
            },
            reply
          )

        function deleteAccountIfUnverified() {
          return db.emailRecord(email)
            .then((emailRecord) => {
              if (emailRecord.emailVerified) {
                throw error.verifiedPrimaryEmailAlreadyExists()
              }

              // Check to see if this account has been unverified for longer than
              // a day, if so, delete account so another user can add it as a
              // secondary email
              const msSinceCreated = Date.now() - emailRecord.createdAt
              const minUnverifiedAccountTime = config.secondaryEmail.minUnverifiedAccountTime
              if (msSinceCreated >= minUnverifiedAccountTime) {
                return db.deleteAccount(emailRecord)
              } else {
                throw error.unverifiedPrimaryEmailNewlyCreated()
              }
            })
            .catch((err) => {
              // Email does not exist in primary account table, carry on
              if (err.errno !== error.ERRNO.ACCOUNT_UNKNOWN) {
                throw err
              }
            })
        }

        function deleteSecondaryEmailIfUnverified() {
          return db.getSecondaryEmail(email)
            .then((secondaryEmailRecord) => {
              // Only delete secondary email if it is unverified and does not belong
              // to the current user.
              if (! secondaryEmailRecord.isVerified && ! butil.buffersAreEqual(secondaryEmailRecord.uid, uid)) {
                return db.deleteEmail(secondaryEmailRecord.uid, secondaryEmailRecord.email)
              }
            })
            .catch((err) => {
              if (err.errno !== error.ERRNO.SECONDARY_EMAIL_UNKNOWN) {
                throw err
              }
            })
        }

        function generateRandomValues() {
          return random.hex(16)
            .then(hex => {
              emailData.emailCode = hex
            })
        }

        function createEmail() {
          return db.createEmail(uid, emailData)
        }

        function sendEmailVerification() {
          return getGeoData(ip)
            .then((geoData) => {
              return mailer.sendVerifySecondaryEmail([emailData], sessionToken, {
                code: emailData.emailCode,
                acceptLanguage: request.app.acceptLanguage,
                email: emailData.email,
                primaryEmail: primaryEmail,
                ip: ip,
                location: geoData.location,
                timeZone: geoData.timeZone,
                uaBrowser: sessionToken.uaBrowser,
                uaBrowserVersion: sessionToken.uaBrowserVersion,
                uaOS: sessionToken.uaOS,
                uaOSVersion: sessionToken.uaOSVersion,
              })
            })
        }
      }
    },
    {
      method: 'POST',
      path: '/recovery_email/destroy',
      config: {
        auth: {
          strategy: 'sessionTokenWithVerificationStatus'
        },
        validate: {
          payload: {
            email: validators.email().required()
          }
        },
        response: {}
      },
      handler: function (request, reply) {
        const sessionToken = request.auth.credentials
        const uid = sessionToken.uid
        const primaryEmail = sessionToken.email
        const email = request.payload.email

        log.begin('Account.RecoveryEmailDestroy', request)

        if (! features.isSecondaryEmailEnabled(primaryEmail)) {
          return reply(error.featureNotEnabled())
        }

        if (sessionToken.tokenVerificationId) {
          return reply(error.unverifiedSession())
        }

        customs.check(request, primaryEmail, 'deleteEmail')
          .then(deleteEmail)
          .done(() => {
            reply({})
          }, reply)

        function deleteEmail() {
          return db.deleteEmail(uid, email.toLowerCase())
        }
      }
    },
    {
      method: 'POST',
      path: '/account/unlock/resend_code',
      config: {
        validate: {
          payload: true
        }
      },
      handler: function (request, reply) {
        log.error({ op: 'Account.UnlockCodeResend', request: request })
        reply(error.gone())
      }
    },
    {
      method: 'POST',
      path: '/account/unlock/verify_code',
      config: {
        validate: {
          payload: true
        }
      },
      handler: function (request, reply) {
        log.error({ op: 'Account.UnlockCodeVerify', request: request })
        reply(error.gone())
      }
    },
    {
      method: 'POST',
      path: '/account/login/send_unblock_code',
      config: {
        validate: {
          payload: {
            email: validators.email().required(),
            metricsContext: METRICS_CONTEXT_SCHEMA
          }
        }
      },
      handler: function (request, reply) {
        log.begin('Account.SendUnblockCode', request)

        var email = request.payload.email
        var ip = request.app.clientAddress
        var emailRecord

        request.validateMetricsContext()

        // Store flowId and flowBeginTime to send in email
        let flowId, flowBeginTime
        if (request.payload.metricsContext) {
          flowId = request.payload.metricsContext.flowId
          flowBeginTime = request.payload.metricsContext.flowBeginTime
        }

        return customs.check(request, email, 'sendUnblockCode')
          .then(lookupAccount)
          .then(createUnblockCode)
          .then(mailUnblockCode)
          .then(() => request.emitMetricsEvent('account.login.sentUnblockCode'))
          .then(() => {
            reply({})
          }, reply)

        function lookupAccount() {
          return db.emailRecord(email)
            .then((record) => {
              emailRecord = record
              return record.uid
            })
        }

        function createUnblockCode(uid) {
          return db.createUnblockCode(uid)
        }

        function mailUnblockCode(code) {
          return P.all([getGeoData(ip), db.accountEmails(emailRecord.uid)])
            .spread((geoData, emails) => {
              return mailer.sendUnblockCode(emails, emailRecord, userAgent.call({
                acceptLanguage: request.app.acceptLanguage,
                unblockCode: code,
                flowId: flowId,
                flowBeginTime: flowBeginTime,
                ip: ip,
                location: geoData.location,
                timeZone: geoData.timeZone
              }, request.headers['user-agent'], log))
            })
        }
      }
    },
    {
      method: 'POST',
      path: '/account/login/reject_unblock_code',
      config: {
        validate: {
          payload: {
            uid: isA.string().max(32).regex(HEX_STRING).required(),
            unblockCode: isA.string().regex(BASE_36).length(unblockCodeLen).required()
          }
        }
      },
      handler: function (request, reply) {
        var uid = request.payload.uid
        var code = request.payload.unblockCode.toUpperCase()

        log.begin('Account.RejectUnblockCode', request)
        db.consumeUnblockCode(uid, code)
          .then(
            () => {
              log.info({
                op: 'account.login.rejectedUnblockCode',
                uid: request.payload.uid,
                unblockCode: code
              })
              return {}
            }
          ).then(reply, reply)
      }
    },
    {
      method: 'POST',
      path: '/account/reset',
      config: {
        auth: {
          strategy: 'accountResetToken',
          payload: 'required'
        },
        validate: {
          query: {
            keys: isA.boolean().optional()
          },
          payload: {
            authPW: isA.string().min(64).max(64).regex(HEX_STRING).required(),
            sessionToken: isA.boolean().optional(),
            metricsContext: METRICS_CONTEXT_SCHEMA
          }
        }
      },
      handler: function accountReset(request, reply) {
        log.begin('Account.reset', request)
        var accountResetToken = request.auth.credentials
        var authPW = request.payload.authPW
        var account, sessionToken, keyFetchToken, verifyHash, wrapKb, devicesToNotify
        var hasSessionToken = request.payload.sessionToken

        request.validateMetricsContext()

        let flowCompleteSignal
        if (requestHelper.wantsKeys(request)) {
          flowCompleteSignal = 'account.signed'
        } else {
          flowCompleteSignal = 'account.reset'
        }
        request.setMetricsFlowCompleteSignal(flowCompleteSignal)

        return fetchDevicesToNotify()
          .then(resetAccountData)
          .then(createSessionToken)
          .then(createKeyFetchToken)
          .then(recordSecurityEvent)
          .then(createResponse)
          .then(reply, reply)

        function fetchDevicesToNotify() {
          // We fetch the devices to notify before resetAccountData() because
          // db.resetAccount() deletes all the devices saved in the account.
          return db.devices(accountResetToken.uid)
            .then(
              function(devices) {
                devicesToNotify = devices
              }
            )
        }

        function resetAccountData () {
          let authSalt, password, wrapWrapKb
          return random.hex(32, 32)
            .then(hexes => {
              authSalt = hexes[0]
              wrapWrapKb = hexes[1]
              password = new Password(authPW, authSalt, config.verifierVersion)
              return password.verifyHash()
            })
            .then(
              function (verifyHashData) {
                verifyHash = verifyHashData

                return db.resetAccount(
                  accountResetToken,
                  {
                    authSalt: authSalt,
                    verifyHash: verifyHash,
                    wrapWrapKb: wrapWrapKb,
                    verifierVersion: password.version
                  }
                )
              }
            )
            .then(
              function () {
                // Notify the devices that the account has changed.
                push.notifyPasswordReset(accountResetToken.uid, devicesToNotify)

                return db.account(accountResetToken.uid)
              }
            )
            .then(
              function (accountData) {
                account = accountData
                return P.all([
                  request.emitMetricsEvent('account.reset', {
                    uid: account.uid
                  }),
                  log.notifyAttachedServices('reset', request, {
                    uid: account.uid,
                    iss: config.domain,
                    generation: account.verifierSetAt
                  }),
                  customs.reset(account.email),
                  password.unwrap(account.wrapWrapKb)
                ])
              }
            )
            .then(
              function (results) {
                wrapKb = results[3]
              }
            )
        }

        function createSessionToken () {
          if (hasSessionToken) {
            // Since the only way to reach this point is clicking a
            // link from the user's email, we create a verified sessionToken
            var sessionTokenOptions = {
              uid: account.uid,
              email: account.email,
              emailCode: account.emailCode,
              emailVerified: account.emailVerified,
              verifierSetAt: account.verifierSetAt
            }

            return db.createSessionToken(sessionTokenOptions, request.headers['user-agent'])
              .then(
                function (result) {
                  sessionToken = result
                  return request.stashMetricsContext(sessionToken)
                }
              )
          }
        }

        function createKeyFetchToken () {
          if (requestHelper.wantsKeys(request)) {
            if (! hasSessionToken) {
              // Sanity-check: any client requesting keys,
              // should also be requesting a sessionToken.
              throw error.missingRequestParameter('sessionToken')
            }
            return db.createKeyFetchToken({
              uid: account.uid,
              kA: account.kA,
              wrapKb: wrapKb,
              emailVerified: account.emailVerified
            })
            .then(
              function (result) {
                keyFetchToken = result
                return request.stashMetricsContext(keyFetchToken)
              }
            )
          }
        }

        function recordSecurityEvent() {
          db.securityEvent({
            name: 'account.reset',
            uid: account.uid,
            ipAddr: request.app.clientAddress,
            tokenId: sessionToken && sessionToken.tokenId
          })
        }

        function createResponse () {
          // If no sessionToken, this could be a legacy client
          // attempting to reset an account password, return legacy response.
          if (! hasSessionToken) {
            return {}
          }


          var response = {
            uid: sessionToken.uid,
            sessionToken: sessionToken.data,
            verified: sessionToken.emailVerified,
            authAt: sessionToken.lastAuthAt()
          }

          if (requestHelper.wantsKeys(request)) {
            response.keyFetchToken = keyFetchToken.data
          }

          return response
        }
      }
    },
    {
      method: 'POST',
      path: '/account/destroy',
      config: {
        validate: {
          payload: {
            email: validators.email().required(),
            authPW: isA.string().min(64).max(64).regex(HEX_STRING).required()
          }
        }
      },
      handler: function accountDestroy(request, reply) {
        log.begin('Account.destroy', request)
        var form = request.payload
        var authPW = form.authPW
        var uid
        var devicesToNotify
        customs.check(
          request,
          form.email,
          'accountDestroy')
          .then(db.emailRecord.bind(db, form.email))
          .then(
            function (emailRecord) {
              uid = emailRecord.uid

              return checkPassword(emailRecord, authPW, request.app.clientAddress)
                .then(
                  function (match) {
                    if (! match) {
                      throw error.incorrectPassword(emailRecord.email, form.email)
                    }
                    // We fetch the devices to notify before deleteAccount()
                    // because obviously we can't retrieve the devices list after!
                    return db.devices(uid)
                  }
                )
                .then(
                  function (devices) {
                    devicesToNotify = devices
                    return db.deleteAccount(emailRecord)
                  }
                )
                .then(
                  function () {
                    push.notifyAccountDestroyed(uid, devicesToNotify).catch(function () {})
                    return P.all([
                      log.notifyAttachedServices('delete', request, {
                        uid: uid,
                        iss: config.domain
                      }),
                      request.emitMetricsEvent('account.deleted', {
                        uid: uid
                      })
                    ])
                  }
                )
                .then(
                  function () {
                    return {}
                  }
                )
            },
            function (err) {
              if (err.errno === error.ERRNO.ACCOUNT_UNKNOWN) {
                customs.flag(request.app.clientAddress, {
                  email: form.email,
                  errno: err.errno
                })
              }
              throw err
            }
          )
          .then(reply, reply)
      }
    }
  ]

  if (config.isProduction) {
    delete routes[0].config.validate.payload.preVerified
  } else {
    // programmatic account lockout was only available in
    // non-production mode.
    routes.push({
      method: 'POST',
      path: '/account/lock',
      config: {
        validate: {
          payload: true
        }
      },
      handler: function (request, reply) {
        log.error({ op: 'Account.lock', request: request })
        reply(error.gone())
      }
    })
  }

  return routes
}
