const express = require('express')
const utils = require('./utils')
const deployer = require('./deployer')

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'testing'
const PORT = process.env.PORT || 3000

const app = express()
app.disable('x-powered-by')
app.use(express.json())

app.use((req, res, next) => {
  if (utils.verifySignature(req, JSON.stringify(req.body), WEBHOOK_SECRET)) {
    next()
  } else {
    res.sendStatus(500)
  }
})

app.post('/', (req, res) => {
  const eventType = req.header('X-GitHub-Event')
  res.sendStatus(200)

  return handleEvent(eventType, req)
    .catch(err => {
      console.error(err)
    })
})

function handleEvent (eventType, req) {
  switch (eventType) {
    case 'pull_request':
      return deployer.pullRequestEvent(req)
    case 'check_suite':
      return deployer.checkSuiteEvent(req)
    case 'delete':
      return deployer.deleteEvent(req)
    default:
      // Just ignore the event
      return Promise.resolve()
  }
}

app.listen(PORT, () => console.log(`Listening to port ${PORT}`))
