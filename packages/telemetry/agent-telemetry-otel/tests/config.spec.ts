import { describe, expect, it } from 'vitest'
import { Config, ENVIRONMENT_VARIABLES, parseKeyValueList, resolveDestinations, withEnvironment } from '../src/config.ts'

const resolve = (fields: Partial<Config>) => resolveDestinations(Config(fields), 'default-service')

describe('OpenTelemetry exporter settings', () => {
  it('exports nothing without an endpoint', () => {
    expect(resolve({})).toEqual({ resourceAttributes: { 'service.name': 'default-service' } })
    expect(resolve({ endpoint: '  ', protocol: 'http/json' })).toEqual({ resourceAttributes: { 'service.name': 'default-service' } })
  })

  it('appends signal paths to the base endpoint and uses protobuf by default', () => {
    for (const endpoint of ['http://collector.test:4318', 'http://collector.test:4318/']) {
      expect(resolve({ endpoint })).toEqual({
        logs: { url: 'http://collector.test:4318/v1/logs', encoding: 'protobuf', headers: {} },
        traces: { url: 'http://collector.test:4318/v1/traces', encoding: 'protobuf', headers: {} },
        resourceAttributes: { 'service.name': 'default-service' },
      })
    }
  })

  it('prefers signal endpoints, protocols, and headers over the shared ones', () => {
    const resolved = resolve({
      endpoint: 'https://collector.test/base', tracesEndpoint: 'https://traces.test/custom',
      protocol: 'http/json', logsProtocol: 'http/protobuf',
      headers: 'authorization=Bearer%20shared, x-tenant = house', tracesHeaders: 'authorization=Bearer%20traces',
      logsHeaders: ',x-extra=a%3Db,',
    })
    expect(resolved.logs).toEqual({ url: 'https://collector.test/base/v1/logs', encoding: 'protobuf',
      headers: { authorization: 'Bearer shared', 'x-tenant': 'house', 'x-extra': 'a=b' } })
    expect(resolved.traces).toEqual({ url: 'https://traces.test/custom', encoding: 'json',
      headers: { authorization: 'Bearer traces', 'x-tenant': 'house' } })
  })

  it('turns off a signal whose exporter is none, or every signal when disabled', () => {
    expect(resolve({ endpoint: 'http://c.test', logsExporter: 'none', tracesExporter: 'otlp' })).not.toHaveProperty('logs')
    expect(resolve({ endpoint: 'http://c.test', tracesExporter: 'none' })).not.toHaveProperty('traces')
    expect(resolve({ endpoint: 'http://c.test', disabled: true, serviceName: 'dsh' })).toEqual({ resourceAttributes: { 'service.name': 'dsh' } })
  })

  it('applies service.name from the service name, then the resource attributes, then the default', () => {
    expect(resolve({ resourceAttributes: 'service.name=from-resource,host.name=laptop' }).resourceAttributes)
      .toEqual({ 'service.name': 'from-resource', 'host.name': 'laptop' })
    expect(resolve({ serviceName: 'dsh', resourceAttributes: 'service.name=from-resource' }).resourceAttributes)
      .toEqual({ 'service.name': 'dsh' })
  })

  it.each([
    [{ endpoint: 'http://c.test', logsExporter: 'console' }, /unsupported logs exporter "console"/],
    [{ endpoint: 'http://c.test', protocol: 'grpc' }, /unsupported logs protocol "grpc"/],
    [{ endpoint: 'not a url' }, /logs endpoint must be a valid HTTP\(S\) URL/],
    [{ tracesEndpoint: 'ftp://c.test/v1/traces' }, /traces endpoint must use HTTP or HTTPS/],
    [{ headers: 'novalue' }, /headers entries must have the form key=value/],
    [{ resourceAttributes: '=value' }, /resourceAttributes entries must have the form key=value/],
  ] satisfies [Partial<Config>, RegExp][])('rejects malformed settings: %j', (fields, message) => {
    expect(() => resolve(fields)).toThrow(message)
  })

  it('fills omitted fields from the OpenTelemetry environment variables', () => {
    const environment: Record<string, string> = { OTEL_SDK_DISABLED: ' TRUE ', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://env.test', OTEL_SERVICE_NAME: 'from-env' }
    const lookup = (name: string) => environment[name]
    expect(withEnvironment(Config({}), lookup)).toMatchObject({ disabled: true, endpoint: 'http://env.test', serviceName: 'from-env' })
    expect(withEnvironment(Config({ disabled: false, endpoint: 'http://config.test' }), lookup))
      .toMatchObject({ disabled: false, endpoint: 'http://config.test', serviceName: 'from-env' })
    expect(withEnvironment(Config({}), () => undefined)).toEqual(expect.objectContaining({ disabled: false }))
    expect(withEnvironment(Config({}), () => undefined)).not.toHaveProperty('endpoint')
    expect(Object.values(ENVIRONMENT_VARIABLES)).toContain('OTEL_EXPORTER_OTLP_TRACES_HEADERS')
  })

  it('never puts a header value in its error', () => {
    expect(() => parseKeyValueList('authorization=Bearer%zzsecret', 'headers')).toThrow(/headers value of "authorization" is not valid percent-encoding/)
    expect(() => parseKeyValueList('authorization=Bearer%zzsecret', 'headers')).not.toThrow(/secret/)
  })
})
