const redis = require('./redis')
const redisUtils = require('./utils/redisUtils')
const express = require('express')
const WebSocket = require('ws')

const LINK_HOST = process.env.LINK_HOST
if (LINK_HOST === undefined || LINK_HOST === null || LINK_HOST === '') {
  console.error('Error: Missing environment variable LINK_HOST, should be set like LINK_HOST=example.com')
  process.exit(1)
}

function start (ws) {
  const app = express()

  app.set('views', './src/views')
  app.set('view engine', 'pug')

  app.get('/', async (req, res) => {
    const statuses = await getBuildStatus()
    const queue = await getBuildQueue()
    res.render('index', { statuses, queue, linkHost: LINK_HOST })
  })
  app.use('/static', express.static('src/public'))

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
            broadcast(ws, JSON.stringify({ html, event: 'status' }))
          })
        })
      } else if (command === 'lpop' || command === 'lindex' || command === 'lrem' || command === 'rpush') {
        getBuildQueue().then(queue => {
          app.render('queue', { queue }, (err, html) => {
            if (err) {
              console.error(err)
              return
            }
            broadcast(ws, JSON.stringify({ html, event: 'queue' }))
          })
        })
      }
    })
  })

  // Ping the client to keep the connection alive for as long as possible
  setInterval(() => {
    // sse.send('ping')
  }, 30 * 1000)

  return app
}

function broadcast (ws, data) {
  ws.clients.forEach(function each (client) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data)
    }
  })
}

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

async function getBuildQueue () {
  const data = await redis.lrange('job_queue', 0, -1)
  return data.map(val => JSON.parse(val))
}

module.exports = start
