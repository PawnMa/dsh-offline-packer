/**
 * Unit tests for the semver subset behind the DSH version matrix
 * (`lib/registry.mjs` → `satisfiesDsh`).
 *
 * Run: node test/b/test-satisfies.mjs
 */

import assert from 'node:assert/strict'

import { satisfiesDsh } from '../../lib/registry.mjs'

let checks = 0
let failures = 0

function check(version, range, expected, label = '') {
  checks += 1
  let actual
  try {
    actual = satisfiesDsh(version, range)
  } catch (error) {
    failures += 1
    console.error(`FAIL ${version} ⊨ ${range} → threw ${error.code ?? ''} ${error.message} ${label}`)
    return
  }
  if (actual !== expected) {
    failures += 1
    console.error(`FAIL ${version} ⊨ ${range} → ${actual}, expected ${expected} ${label}`)
  }
}

function checkThrows(version, range, code, label = '') {
  checks += 1
  try {
    satisfiesDsh(version, range)
    failures += 1
    console.error(`FAIL ${version} ⊨ ${range} → did not throw, expected ${code} ${label}`)
  } catch (error) {
    if (error.code !== code) {
      failures += 1
      console.error(`FAIL ${version} ⊨ ${range} → threw ${error.code}, expected ${code} ${label}`)
    }
  }
}

// --- The prerelease cases required by the task -----------------------------
check('0.1.0-rc.8', '^0.1.0-rc.7', true, '(caret accepts newer rc of same triple)')
check('0.2.0-rc.1', '^0.1.0-rc.7', false, '(caret rejects next minor rc)')
check('0.1.0-rc.6', '^0.1.0-rc.7', false, '(caret rejects older rc)')
check('0.1.0-rc.7', '^0.1.0-rc.7', true, '(caret accepts the lower bound itself)')
check('0.2.1-rc.2', '^0.2.1-rc.1', true, '(caret accepts newer rc of same triple)')
check('0.2.1-rc.1', '^0.2.1-rc.1', true)
check('0.2.2-rc.1', '^0.2.1-rc.1', false, '(caret bound is <0.3.0-0, but rc of 0.2.2 has no matching triple)')

// --- stable versions under caret ------------------------------------------
check('0.1.0', '^0.1.0-rc.7', true, '(final release is above its rc)')
check('0.1.1', '^0.1.0-rc.7', true)
check('0.2.0', '^0.1.0-rc.7', false)
check('0.1.5', '^0.1.0', true)
check('0.2.0', '^0.1.0', false, '(npm caret on 0.x pins the minor)')
check('0.3.0', '^0.2.0', false, '(npm caret on 0.x pins the minor)')
check('1.2.9', '^1.2.0', true)
check('1.3.0', '^1.2.0', true, '(caret on 1.x allows minor updates)')
check('2.0.0', '^1.2.0', false)
check('1.2.3', '1.x', true)
check('2.0.0', '1.x', false)

// --- tilde ---------------------------------------------------------------
check('1.2.9', '~1.2.3', true)
check('1.3.0', '~1.2.3', false)
check('0.1.5', '~0.1.3', true)
check('0.1.0-rc.8', '~0.1.0-rc.7', true, '(tilde accepts newer rc of same triple)')

// --- comparators, exact, unions, wildcard --------------------------------
check('0.1.0-rc.8', '>=0.1.0-rc.7', true)
check('0.1.0-rc.6', '>=0.1.0-rc.7', false)
check('0.1.0-rc.8', '>=0.1.0', false, '(plain ranges do not match prereleases)')
check('0.1.0-rc.8', '*', true, '(wildcard accepts prereleases)')
check('0.2.0', '*', true)
check('0.1.0-rc.8', '0.1.0-rc.8', true)
check('0.1.0-rc.9', '0.1.0-rc.8', false)
check('0.1.0-rc.8', '=0.1.0-rc.8', true)
check('0.1.0', '0.1.0-rc.7', false, '(exact rc range does not match final release)')
check('0.2.1-rc.2', '^0.1.0-rc.7 || ^0.2.1-rc.1', true)
check('0.5.0', '^0.1.0-rc.7 || ^0.2.1-rc.1', false)
check('0.2.1', '>=0.1.0-rc.7 <0.3.0', true)
check('0.3.1', '>=0.1.0-rc.7 <0.3.0', false)
check('0.2.0', '>0.1.0', true)
check('0.1.0', '>0.1.0', false)
check('0.1.0', '<=0.1.0', true)
check('0.1.1', '<=0.1.0', false)
check('1.2.0', '1.2.x', true)
check('1.2.5', '1.2.x', true)
check('1.3.0', '1.2.x', false)
check('0.1.0-beta.1', '^0.1.0-beta.1', true)
check('0.1.0-alpha.1', '^0.1.0-beta.1', false, '(alpha < beta)')
check('0.1.0-rc.10', '^0.1.0-rc.9', true, '(numeric prerelease component ordering)')

// --- invalid input -------------------------------------------------------
checkThrows('not-a-version', '^0.1.0', 'INVALID_VERSION')
checkThrows('0.1.0', 'not a range', 'INVALID_RANGE')
checkThrows('0.1.0', '', 'INVALID_RANGE')

if (failures > 0) {
  console.error(`\n${failures}/${checks} satisfiesDsh checks FAILED`)
  process.exit(1)
}
console.log(`satisfiesDsh: ${checks}/${checks} checks passed`)
