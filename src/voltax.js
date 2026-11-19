'use strict';
// Voltax adapter. In v1 there is no Voltax API access, so createUser() does nothing
// and reports "not_configured"; reps enter the Voltax user ID by hand.
//
// When API access arrives, only this file changes: read VOLTAX_API_URL and
// VOLTAX_API_KEY from process.env, create the user, and return
// { status: "created", voltaxUserId } (or { status: "error", error }).

// eslint-disable-next-line no-unused-vars
async function createUser(person, application) {
  return { status: 'not_configured' };
}

module.exports = { createUser };
