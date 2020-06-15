const pm2 = require('pm2')

pm2.connect(err => {
  if (err) {
    console.log(err)
    process.exit(2)
  }

  pm2.start({
    script: 'test2.js', // Script to be run
    exec_mode: 'fork' // Allows your app to be clustered
  }, function (err, apps) {
    pm2.disconnect() // Disconnects from PM2
    if (err) throw err
  })
})

console.log('Test')
process.stdin.resume()
