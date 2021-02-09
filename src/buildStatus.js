const redis = require('./redis')
const redisUtils = require('./utils/redisUtils')
const SSE = require('@gazdagandras/express-sse')
const express = require('express')

const LINK_HOST = process.env.LINK_HOST
if (LINK_HOST === undefined || LINK_HOST === null || LINK_HOST === '') {
  console.error('Error: Missing environment variable LINK_HOST, should be set like LINK_HOST=example.com')
  process.exit(1)
}

const app = express()
const sse = new SSE(['connected']) // Send connected event to init connection
app.set('views', './src/views')
app.set('view engine', 'pug')

app.get('/events/', sse.init)
app.get('/', async (req, res) => {
  const statuses = await getBuildStatus()
  res.render('index', { statuses, linkHost: LINK_HOST })
})
app.use('/static', express.static('src/public'))

// Create array of build statuses
async function getBuildStatus () {
  const keys = await redisUtils.scanKeys(redis, 0, 'MATCH', '*-STATUS')
  if (keys.length === 0) {
    return []
  }

  const statuses = await Promise.all(keys.map(key => redis.hgetall(key)))

  return keys.map((key, index) => {
    const id = key.replace('-STATUS', '')
    return {
      id: id,
      type: id.startsWith('pr-') ? 'pull-request' : 'branch',
      status: statuses[index].status
    }
  })
}

// Monitor Redis event and send events to client when changes are made
redis.monitor().then(monitor => {
  monitor.on('monitor', (time, args, source, database) => {
    const command = args[0].toLowerCase()
    if (command === 'hmset' || command === 'del') {
      getBuildStatus().then(statuses => {
        app.render('table', { statuses, linkHost: LINK_HOST }, (err, html) => {
          if (err) {
            console.error(err)
            return
          }
          sse.send(html, 'status')
        })
      })
    }
  })
})

// Ping the client to keep the connection alive for as long as possible
setInterval(() => {
  sse.send('ping')
}, 30 * 1000)

module.exports = app
