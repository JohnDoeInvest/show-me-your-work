const express = require('express')
const utils = require('./utils/utils')
const deployer = require('./deployer')
const buildStatus = require('./buildStatus')

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'testing'
const PORT = process.env.PORT || 3000

const app = express()
app.disable('x-powered-by')
app.use(express.json())

app.use('/status', buildStatus)

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

  return handleEvent(eventType, req.body)
    .catch(err => {
      console.error(err)
    })
})

function handleEvent (eventType, payload) {
  switch (eventType) {
    case 'pull_request':
      return deployer.pullRequestEvent(eventType, payload)
    case 'check_run':
      return deployer.checkRunEvent(eventType, payload)
    case 'delete':
      return deployer.deleteEvent(eventType, payload)
    default:
      // Just ignore the event
      return Promise.resolve()
  }
}

deployer.checkStatus().then(() => {
  app.listen(PORT, () => console.log(`Listening to port ${PORT}`))
}).catch((e) => {
  console.error(e)
  process.exit(1)
})
