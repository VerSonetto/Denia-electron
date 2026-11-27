import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:denia_mobile/core/errors.dart';
import 'package:denia_mobile/data/api_client.dart';
import 'package:denia_mobile/data/pairing_service.dart';
import 'package:denia_mobile/models/session.dart';
import 'package:flutter_test/flutter_test.dart';

typedef Handler = Future<void> Function(HttpRequest request);

Future<HttpServer> _serve(Handler handler) async {
  final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
  server.listen((request) {
    unawaited(() async {
      try {
        await handler(request);
      } catch (error) {
        request.response.statusCode = 500;
        request.response.headers.contentType = ContentType.json;
        request.response.write(
          jsonEncode({
            'error': {'code': 'test/failure', 'message': '$error'},
          }),
        );
        await request.response.close();
      }
    }());
  });
  return server;
}

String _base(HttpServer server) => 'http://127.0.0.1:${server.port}';

Future<void> _json(HttpRequest request, int status, Object body) async {
  request.response.statusCode = status;
  request.response.headers.contentType = ContentType.json;
  request.response.write(jsonEncode(body));
  await request.response.close();
}

Future<void> _error(
  HttpRequest request,
  int status,
  String code,
  String message,
) {
  return _json(request, status, {
    'error': {'code': code, 'message': message},
  });
}

String _pairingLink({
  required String serverId,
  required List<Map<String, dynamic>> candidates,
  DateTime? expiresAt,
}) {
  final payload = {
    'v': 2,
    'pairingId': 'pair_1',
    'secret': 'secret',
    'serverId': serverId,
    'fingerprint': 'AABB-CCDD',
    'label': '书房电脑',
    'expiresAt':
        (expiresAt ?? DateTime.now().toUtc().add(const Duration(minutes: 5)))
            .toIso8601String(),
    'candidates': candidates,
  };
  final encoded = base64Url
      .encode(utf8.encode(jsonEncode(payload)))
      .replaceAll('=', '');
  return 'denia://connect?v=2&p=$encoded';
}

void main() {
  group('DeniaApi', () {
    test('parses status, sessions, page, prompt and SSE', () async {
      String? lastAuth;
      Map<String, dynamic>? promptBody;
      var onOpen = false;
      final server = await _serve((request) async {
        final path = request.uri.path;
        if (path == '/api/remote/status') {
          await _json(request, 200, {
            'local': false,
            'authenticated':
                request.headers.value('authorization') == 'Bearer good',
            'enabled': true,
            'listening': true,
            'serverId': 'server-1',
            'serverLabel': '书房电脑',
          });
          return;
        }
        lastAuth = request.headers.value('authorization');
        if (lastAuth != 'Bearer good') {
          await _error(request, 401, 'remote/unauthorized', '令牌无效');
          return;
        }
        switch (path) {
          case '/api/sessions':
            await _json(request, 200, {
              'sessions': [
                {
                  'id': 's1',
                  'created_at': 1700000000000,
                  'updated_at': 1700000100000,
                  'title': 'Refactor',
                  'excerpt': 'fix the thing',
                  'cwd': r'D:\work\app',
                  'last_selection': {
                    'provider': 'openai',
                    'model': 'gpt-5',
                    'reasoningEffort': 'high',
                  },
                },
              ],
            });
            return;
          case '/api/sessions/s1/events':
            await _json(request, 200, {
              'header': {
                'id': 's1',
                'cwd': r'D:\work\app',
                'created_at': 1700000000000,
              },
              'events': [
                {
                  'seq': 1,
                  'time': 1700000000000,
                  'type': 'user-message',
                  'text': 'hi',
                  'injected': false,
                },
              ],
              'total': 2,
              'hasMoreBefore': true,
              'anchors': [
                {'seq': 1, 'text': 'hi'},
              ],
              'last_selection': {'provider': 'openai', 'model': 'gpt-5'},
              'last_permission': 'full',
            });
            return;
          case '/api/sessions/s1/prompt':
            promptBody = jsonDecode(
              await utf8.decodeStream(request),
            ) as Map<String, dynamic>;
            await _json(request, 202, {'accepted': true});
            return;
          case '/api/sessions/s1/follow':
            request.response.statusCode = 200;
            request.response.headers.set('content-type', 'text/event-stream');
            request.response.write('retry: 1000\n\n');
            request.response.write(
              'data: {"seq":1,"time":10,"type":"turn-start","turn":1}\n\n',
            );
            request.response.write('data: {"type":"hb"}\n\n');
            request.response.write(
              'data: {"seq":2,"time":20,"type":"turn-end","turn":1,"reason":{"kind":"completed"}}\n\n',
            );
            await request.response.close();
            return;
        }
        await _error(request, 404, 'test/not-found', 'not found');
      });
      addTearDown(() => server.close(force: true));

      final api = DeniaApi(baseUrl: _base(server), token: 'good');
      addTearDown(api.dispose);

      final status = await api.status();
      expect(status.serverId, 'server-1');
      expect(status.authenticated, isTrue);

      final sessions = await api.listSessions();
      expect(sessions, hasLength(1));
      expect(sessions.single.title, 'Refactor');
      expect(sessions.single.cwdName, 'app');
      expect(sessions.single.lastSelection?.model, 'gpt-5');

      final page = await api.fetchSessionPage('s1', limit: 2);
      expect(page.events, hasLength(1));
      expect(page.hasMoreBefore, isTrue);
      expect(page.lastPermission, PermissionChoice.full);
      expect(page.lastSelection?.provider, 'openai');

      await api.sendPrompt(
        's1',
        'hello',
        selection: const ModelChoice(
          provider: 'openai',
          model: 'gpt-5',
          reasoningEffort: 'high',
        ),
      );
      expect(promptBody?['prompt'], 'hello');
      expect(promptBody?['provider'], 'openai');
      expect(promptBody?['model'], 'gpt-5');
      expect(promptBody?['reasoningEffort'], 'high');

      final frames = await api
          .stream(
            '/api/sessions/s1/follow?after=0',
            onOpen: () => onOpen = true,
          )
          .toList();
      expect(onOpen, isTrue);
      expect(frames, hasLength(3));
      final start = jsonDecode(frames[0].data) as Map<String, dynamic>;
      expect(start['type'], 'turn-start');
      expect(frames[1].data, '{"type":"hb"}');
      final end = jsonDecode(frames[2].data) as Map<String, dynamic>;
      expect(end['type'], 'turn-end');

      final badApi = DeniaApi(baseUrl: _base(server), token: 'bad');
      addTearDown(badApi.dispose);
      await expectLater(
        badApi.listSessions(),
        throwsA(
          isA<ApiException>()
              .having((error) => error.status, 'status', 401)
              .having((error) => error.code, 'code', 'remote/unauthorized'),
        ),
      );
    });
  });

  group('PairingService', () {
    test(
      'skips an identity mismatch and redeems on the matching host',
      () async {
        var wrongStatus = 0;
        var wrongRedeem = 0;
        final wrong = await _serve((request) async {
          if (request.uri.path == '/api/remote/status') {
            wrongStatus += 1;
            await _json(request, 200, {
              'serverId': 'other',
              'authenticated': false,
            });
            return;
          }
          if (request.uri.path == '/api/remote/redeem') {
            wrongRedeem += 1;
          }
          await _error(request, 404, 'test/not-found', 'not found');
        });
        addTearDown(() => wrong.close(force: true));

        var rightStatus = 0;
        var rightRedeem = 0;
        String? statusAuth;
        String? redeemAuth;
        Map<String, dynamic>? redeemBody;
        final right = await _serve((request) async {
          if (request.uri.path == '/api/remote/status') {
            rightStatus += 1;
            statusAuth = request.headers.value('authorization');
            await _json(request, 200, {
              'serverId': 'server-1',
              'serverLabel': '书房电脑',
              'authenticated': false,
            });
            return;
          }
          if (request.uri.path == '/api/remote/redeem') {
            rightRedeem += 1;
            redeemAuth = request.headers.value('authorization');
            redeemBody = jsonDecode(
              await utf8.decodeStream(request),
            ) as Map<String, dynamic>;
            await _json(request, 200, {
              'ok': true,
              'clientToken': 'client-token',
              'client': {
                'id': 'client-1',
                'label': 'Pixel',
                'clientKind': 'mobile',
              },
              'server': {'label': '书房电脑', 'fingerprint': 'AABB-CCDD'},
            });
            return;
          }
          await _error(request, 404, 'test/not-found', 'not found');
        });
        addTearDown(() => right.close(force: true));

        final link = _pairingLink(
          serverId: 'server-1',
          candidates: [
            {'type': 'lan', 'url': _base(wrong), 'priority': 10},
            {'type': 'tunnel', 'url': _base(right), 'priority': 20},
          ],
        );
        final service = PairingService();
        final paired = await service.pairWithLink(
          link: link,
          deviceName: 'Pixel',
          installId: 'install-1',
        );

        expect(wrongStatus, 1);
        expect(wrongRedeem, 0);
        expect(rightStatus, 1);
        expect(rightRedeem, 1);
        expect(statusAuth, isNull);
        expect(redeemAuth, isNull);
        expect(paired.serverId, 'server-1');
        expect(paired.token, 'client-token');
        expect(paired.clientId, 'client-1');
        expect(paired.activeUrl, _base(right));
        expect(paired.candidates, hasLength(2));
        expect(redeemBody?['clientKind'], 'mobile');
        expect(redeemBody?['devicePlatform'], 'android');
        expect(redeemBody?['dedupeKey'], 'install:install-1');
        expect(redeemBody?['deviceName'], 'Pixel');
        expect(redeemBody?['link'], link);
      },
    );

    test('refuses to redeem against a host with the wrong server id', () async {
      var redeemCalls = 0;
      final server = await _serve((request) async {
        if (request.uri.path == '/api/remote/status') {
          await _json(request, 200, {'serverId': 'other'});
          return;
        }
        if (request.uri.path == '/api/remote/redeem') redeemCalls += 1;
        await _error(request, 404, 'test/not-found', 'not found');
      });
      addTearDown(() => server.close(force: true));

      final link = _pairingLink(
        serverId: 'server-1',
        candidates: [
          {'type': 'lan', 'url': _base(server), 'priority': 10},
        ],
      );
      await expectLater(
        PairingService().pairWithLink(
          link: link,
          deviceName: 'Pixel',
          installId: 'install-1',
        ),
        throwsA(isA<PairingException>()),
      );
      expect(redeemCalls, 0);
    });

    test('surfaces rate limiting as a stable user message', () async {
      final server = await _serve((request) async {
        if (request.uri.path == '/api/remote/status') {
          await _json(request, 200, {'serverId': 'server-1'});
          return;
        }
        await _error(request, 429, 'remote/redeem-failed', '配对码无效或已过期');
      });
      addTearDown(() => server.close(force: true));

      final link = _pairingLink(
        serverId: 'server-1',
        candidates: [
          {'type': 'lan', 'url': _base(server), 'priority': 10},
        ],
      );
      await expectLater(
        PairingService().pairWithLink(
          link: link,
          deviceName: 'Pixel',
          installId: 'install-1',
        ),
        throwsA(
          isA<PairingException>().having(
            (error) => error.message,
            'message',
            contains('频繁'),
          ),
        ),
      );
    });

    test('manual address defaults to HTTP and normalizes the code', () async {
      Map<String, dynamic>? redeemBody;
      final server = await _serve((request) async {
        if (request.uri.path == '/api/remote/status') {
          await _json(request, 200, {
            'serverId': 'server-1',
            'serverLabel': '书房电脑',
          });
          return;
        }
        if (request.uri.path == '/api/remote/redeem') {
          redeemBody = jsonDecode(
            await utf8.decodeStream(request),
          ) as Map<String, dynamic>;
          await _json(request, 200, {
            'ok': true,
            'clientToken': 'token',
            'client': {'id': 'client-1', 'label': '我的手机'},
            'server': {'label': '书房电脑', 'fingerprint': 'AABB-CCDD'},
          });
          return;
        }
        await _error(request, 404, 'test/not-found', 'not found');
      });
      addTearDown(() => server.close(force: true));

      final paired = await PairingService().pairWithCode(
        address: '127.0.0.1:${server.port}',
        code: 'abcd-efgh',
        deviceName: '我的手机',
        installId: 'install-1',
      );
      expect(redeemBody?['code'], 'ABCDEFGH');
      expect(paired.candidates.single.url.toString(), _base(server));
      expect(paired.activeUrl, _base(server));
    });
  });
}
