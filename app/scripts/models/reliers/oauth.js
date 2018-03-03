/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * An OAuth Relier - holds OAuth information.
 */

define(function (require, exports, module) {
  'use strict';

  const _ = require('underscore');
  const Constants = require('../../lib/constants');
  const OAuthErrors = require('../../lib/oauth-errors');
  const Relier = require('./relier');
  const Transform = require('../../lib/transform');
  const Vat = require('../../lib/vat');

  /*eslint-disable camelcase*/
  var CLIENT_INFO_SCHEMA = {
    id: Vat.hex().required().renameTo('clientId'),
    image_uri: Vat.url().allow('').renameTo('imageUri'),
    name: Vat.string().required().min(1).renameTo('serviceName'),
    redirect_uri: Vat.url().required().renameTo('redirectUri'),
    trusted: Vat.boolean().required()
  };

  var SIGNIN_SIGNUP_QUERY_PARAM_SCHEMA = {
    access_type: Vat.accessType().renameTo('accessType'),
    client_id: Vat.clientId().required().renameTo('clientId'),
    code_challenge: Vat.codeChallenge().renameTo('codeChallenge'),
    code_challenge_method: Vat.codeChallengeMethod().renameTo('codeChallengeMethod'),
    keys_jwk: Vat.keysJwk().renameTo('keysJwk'),
    prompt: Vat.prompt(),
    redirectTo: Vat.url(),
    redirect_uri: Vat.url().renameTo('redirectUri'),
    scope: Vat.string().required().min(1),
    state: Vat.string()
  };

  var VERIFICATION_INFO_SCHEMA = {
    access_type: Vat.accessType().renameTo('accessType'),
    action: Vat.string().min(1),
    client_id: Vat.clientId().required().renameTo('clientId'),
    prompt: Vat.prompt(),
    redirect_uri: Vat.url().renameTo('redirectUri'),
    // scopes are optional when verifying, user could be verifying in a 2nd browser
    scope: Vat.string().min(1),
    // `service` for OAuth verification is a clientId
    service: Vat.clientId(),
    state: Vat.string().min(1)
  };

  /*eslint-enable camelcase*/

  var OAuthRelier = Relier.extend({
    defaults: _.extend({}, Relier.prototype.defaults, {
      accessType: null,
      clientId: null,
      context: Constants.OAUTH_CONTEXT,
      keysJwk: null,
      // permissions are individual scopes
      permissions: null,
      // whether the permissions prompt will be shown to trusted reliers
      prompt: null,
      // redirectTo is for future use by the oauth flow. redirectTo
      // would have redirectUri as its base.
      redirectTo: null,
      // redirectUri is used by the oauth flow
      redirectUri: null,
      // a rollup of all the permissions
      scope: null,
      // standard oauth parameters.
      state: null
    }),

    initialize (attributes, options = {}) {
      Relier.prototype.initialize.call(this, attributes, options);

      this._config = options.config;
      this._oAuthClient = options.oAuthClient;
      this._session = options.session;
    },

    fetch () {
      return Relier.prototype.fetch.call(this)
        .then(() => {
          if (this._isVerificationFlow()) {
            this._setupVerificationFlow();
          } else {
            this._setupSignInSignUpFlow();
          }

          if (! this.has('service')) {
            this.set('service', this.get('clientId'));
          }

          return this._setupOAuthRPInfo(this._isVerificationFlow());
        })
        .then(() => {
          if (this.has('scope')) {
            // normalization depends on `trusted` field set in
            // setupOAuthRPInfo.
            this._normalizeScopesAndPermissions();
          }
        });
    },

    _normalizeScopesAndPermissions () {
      var permissions = scopeStrToArray(this.get('scope'));
      if (this.isTrusted()) {
        // We have to normalize `profile` into is expanded sub-scopes
        // in order to show the consent screen.
        if (this.wantsConsent()) {
          permissions = replaceItemInArray(
            permissions,
            Constants.OAUTH_TRUSTED_PROFILE_SCOPE,
            Constants.OAUTH_TRUSTED_PROFILE_SCOPE_EXPANSION
          );
        }
      } else {
        permissions = sanitizeUntrustedPermissions(permissions);
      }

      if (! permissions.length) {
        throw OAuthErrors.toInvalidParameterError('scope');
      }

      this.set('scope', permissions.join(' '));
      this.set('permissions', permissions);
    },

    isOAuth () {
      return true;
    },

    _isVerificationFlow () {
      return !! this.getSearchParam('code');
    },

    _setupVerificationFlow () {
      var resumeObj = this._session.oauth;
      if (! resumeObj) {
        // The user is verifying in a second browser. `service` is
        // available in the link. Use it to populate the `service`
        // and `clientId` fields which will allow the user to
        // redirect back to the RP but not sign in.
        resumeObj = {
          client_id: this.getSearchParam('service'), //eslint-disable-line camelcase
          service: this.getSearchParam('service')
        };
      }

      var result = Transform.transformUsingSchema(
        resumeObj, VERIFICATION_INFO_SCHEMA, OAuthErrors);

      this.set(result);
    },

    _setupSignInSignUpFlow () {
      // params listed in:
      // https://github.com/mozilla/fxa-oauth-server/blob/master/docs/api.md#post-v1authorization
      this.importSearchParamsUsingSchema(
        SIGNIN_SIGNUP_QUERY_PARAM_SCHEMA, OAuthErrors);

      // OAuth reliers are not allowed to specify a service. `service`
      // is used in the verification flow, it'll be set to the `client_id`.
      if (this.getSearchParam('service')) {
        throw OAuthErrors.toInvalidParameterError('service');
      }
    },

    _setupOAuthRPInfo (verificationFlow) {
      const clientId = this.get('clientId');
      // get the app provided redirect uri
      const queryRedirectUri = this.get('redirectUri');

      return this._oAuthClient.getClientInfo(clientId)
        .then((serviceInfo) => {
          const result = Transform.transformUsingSchema(
            serviceInfo, CLIENT_INFO_SCHEMA, OAuthErrors);

          // verification flow doesn't have a redirect uri, so there is nothing to validate
          if (! verificationFlow && result.redirectUri !== queryRedirectUri) {
            // if provided redirect uri doesn't match with client info then throw
            throw OAuthErrors.toError('INCORRECT_REDIRECT');
          }

          this.set(result);
        }, function (err) {
          // the server returns an invalid request parameter for an
          // invalid/unknown client_id
          if (OAuthErrors.is(err, 'INVALID_PARAMETER') &&
              err.validation &&
              err.validation.keys &&
              err.validation.keys[0] === 'client_id') {
            err = OAuthErrors.toError('UNKNOWN_CLIENT');
            // used for logging the error on the server.
            err.client_id = clientId; //eslint-disable-line camelcase
          }
          throw err;
        });
    },

    isTrusted () {
      return this.get('trusted');
    },

    /**
     * Return `true` if the relier sets `prompt=consent`
     *
     * @returns {Boolean} `true` if relier asks for consent, false otw.
     */
    wantsConsent () {
      return this.get('prompt') === Constants.OAUTH_PROMPT_CONSENT;
    },

    /**
     * Check if the relier wants access to the account encryption keys.
     *
     * @returns {Boolean}
     */
    wantsKeys () {
      return !! (this._config && this._config.scopedKeysEnabled && this._validateKeyScopeRequest());
    },

    /**
     * Validate the requested scope with the relier redirect uri.
     * At least one valid match must be found to successfully validate
     * @returns {boolean}
     * @private
     */
    _validateKeyScopeRequest () {
      if (! this.has('keysJwk')) {
        return false;
      }

      const validation = this._config.scopedKeysValidation || {};
      let foundRedirectScopeMatch = false;

      if (! this.get('scope')) {
        throw new Error('Invalid scope parameter');
      }

      scopeStrToArray(this.get('scope')).forEach((scope) => {
        if (validation.hasOwnProperty(scope)) {
          if (validation[scope].redirectUris.includes(this.get('redirectUri'))) {
            foundRedirectScopeMatch = true;
          } else {
            throw new Error('Invalid redirect parameter');
          }
        }
      });

      if (! foundRedirectScopeMatch) {
        throw new Error('No key-bearing scopes requested');
      }

      return true;
    },


    /**
     * Check whether additional permissions are requested from
     * the given account
     *
     * @param {Object} account
     * @returns {Boolean} `true` if additional permissions
     *   are needed, false otw.
     */
    accountNeedsPermissions (account) {
      if (this.isTrusted() && ! this.wantsConsent()) {
        return false;
      }

      // only check permissions for which the account has a value.
      var applicableProfilePermissions =
        account.getPermissionsWithValues(this.get('permissions'));

      return ! account.hasSeenPermissions(
        this.get('clientId'), applicableProfilePermissions);
    }
  });

  function replaceItemInArray(array, itemToReplace, replaceWith) {
    var without = _.without(array, itemToReplace);
    if (without.length !== array.length) {
      return _.union(without, replaceWith);
    }
    return array;
  }

  function scopeStrToArray(scopes) {
    if (! _.isString) {
      return [];
    }

    var trimmedScopes = scopes.trim();
    if (trimmedScopes.length) {
      return _.uniq(scopes.split(/\s+/g));
    } else {
      return [];
    }
  }

  function sanitizeUntrustedPermissions(permissions) {
    return _.intersection(permissions, Constants.OAUTH_UNTRUSTED_ALLOWED_PERMISSIONS);
  }

  module.exports = OAuthRelier;
});
