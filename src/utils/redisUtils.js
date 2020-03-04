function scanKeys (redis, pointer, matchOption, pattern, results = []) {
  return redis.scan(pointer, matchOption, pattern).then(response => {
    results.push(...response[1])
    if (response[0] === '0') {
      return results
    }

    return scanKeys(redis, response[0], matchOption, pattern, results)
  })
}

module.exports = {
  scanKeys
}
