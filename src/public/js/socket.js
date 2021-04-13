const hrefNoProtocol = location.href.replace(location.protocol, '')
const ws = new WebSocket(location.hostname === 'localhost' ? 'ws://localhost:3000' : 'wss://' + hrefNoProtocol)
const domparser = new DOMParser()
ws.addEventListener('message', function (event) {
  const message = JSON.parse(event.data)
  let node
  if (message.event === 'status') {
    node = document.getElementById('status')
  } else if (message.event === 'queue') {
    node = document.getElementById('queue')
  }

  node.innerHTML = ''
  node.appendChild(domparser.parseFromString(message.html, 'text/html').body)
})
