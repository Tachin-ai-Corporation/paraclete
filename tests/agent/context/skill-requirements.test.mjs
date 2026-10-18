// Tests for agent/context/skill-requirements.mjs: a skill.json's `requires` read as a list, the one
// requirement there is (a Workspace account, from the instance record), and the reason a person is
// shown when a skill cannot work here. An unknown requirement is never met.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SKILL_REQUIREMENTS, skillRequires, unavailableReason } from '../../../agent/context/skill-requirements.mjs';

const WITH = { workspace: { account: 'agent@example.com', signer: 'paraclete-dwd@your-gcp-project.iam.gserviceaccount.com' } };

test('requires is read as a list: an array, one string, or nothing', () => {
  assert.deepEqual(skillRequires({ requires: ['workspace'] }), ['workspace']);
  assert.deepEqual(skillRequires({ requires: 'workspace' }), ['workspace']);
  assert.deepEqual(skillRequires({}), []);
  assert.deepEqual(skillRequires({ requires: 3 }), []);
  assert.deepEqual(skillRequires(null), []);
});

test('the Workspace requirement is met only by an instance that names its Workspace account', () => {
  assert.deepEqual(Object.keys(SKILL_REQUIREMENTS), ['workspace']);
  assert.equal(unavailableReason(['workspace'], WITH), null);
  assert.equal(unavailableReason(['workspace'], { workspace: null }), 'needs a Workspace account');
  assert.equal(unavailableReason(['workspace'], { workspace: { account: '' } }), 'needs a Workspace account');
  assert.equal(unavailableReason(['workspace'], null), 'needs a Workspace account');
  assert.equal(unavailableReason([], null), null, 'a skill that requires nothing works anywhere');
});

test('an unknown requirement is never met, and is named', () => {
  assert.equal(unavailableReason(['telepathy'], WITH), "needs 'telepathy', which this instance does not know");
  assert.equal(unavailableReason(['toString'], WITH), "needs 'toString', which this instance does not know", 'object keys are not requirements');
  assert.equal(unavailableReason(['workspace', 'workspace'], {}), 'needs a Workspace account', 'each reason once');
});
