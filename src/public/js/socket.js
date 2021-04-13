const evtSource = new EventSource('/status/events?channel=status')
const domparser = new DOMParser()
evtSource.addEventListener('status', function (event) {
  const html = JSON.parse(event.data)
  const node = document.getElementById('status')
  node.innerHTML = ''
  node.appendChild(domparser.parseFromString(html, 'text/html').body)
})

evtSource.addEventListener('queue', function (event) {
  const html = JSON.parse(event.data)
  const node = document.getElementById('queue')
  node.innerHTML = ''
  node.appendChild(domparser.parseFromString(html, 'text/html').body)
})
