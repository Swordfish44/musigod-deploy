'use strict'

// Disabled after successful production verification of Rights Title Report v1.
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store')
  return res.status(404).json({ error: 'Not found' })
}
