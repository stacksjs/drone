self.onmessage = ({ data }) => {
  if (data !== 'emit') return
  self.onmessage = null
  for (const kind of ['event', 'result', 'finished', 'unrecognized']) self.postMessage({ kind, payload: 'private-callback-payload', bytes: new Uint8Array([1, 2, 3]) })
}
