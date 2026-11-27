import '../core/json.dart';
import 'pairing.dart';

enum PermissionChoice {
  readOnly('read-only', '只读', '只能读取文件，不能改动'),
  autoEdit('auto-edit', '自动编辑', '写文件自动放行，命令仍需审批'),
  plan('plan', '计划', '先给出方案，批准后才执行'),
  approveForMe('approve-for-me', '自动审批', '由自动审查代替人工确认'),
  full('full', '完全访问', '跳过审批，可改文件、执行命令');

  const PermissionChoice(this.wire, this.label, this.description);

  final String wire;
  final String label;
  final String description;

  static PermissionChoice? parse(String? raw) {
    for (final value in PermissionChoice.values) {
      if (value.wire == raw) return value;
    }
    // The older permission-mode union.
    if (raw == 'full') return PermissionChoice.full;
    return null;
  }
}

class RemoteStatus {
  RemoteStatus({
    required this.local,
    required this.authenticated,
    required this.enabled,
    required this.listening,
    this.serverId,
    this.serverLabel,
    this.listenPort,
    this.listenerError,
    this.publicUrl,
    this.clientKind,
    this.relayCandidate,
  });

  final bool local;
  final bool authenticated;
  final bool enabled;
  final bool listening;
  final String? serverId;
  final String? serverLabel;
  final int? listenPort;
  final String? listenerError;
  final String? publicUrl;
  final String? clientKind;

  /// Present only for a paired/authorized request. It lets the phone refresh
  /// the relay address after the host or its Quick Tunnel restarts.
  final PairingCandidate? relayCandidate;

  static RemoteStatus fromJson(JsonMap map) {
    return RemoteStatus(
      local: asBool(map['local']),
      authenticated: asBool(map['authenticated']),
      enabled: asBool(map['enabled']),
      listening: asBool(map['listening']),
      serverId: asStringOrNull(map['serverId']),
      serverLabel: asStringOrNull(map['serverLabel']),
      listenPort:
          asIntOrNull(map['listeningPort']) ?? asIntOrNull(map['listenPort']),
      listenerError: asStringOrNull(map['listenerError']),
      publicUrl: asStringOrNull(map['publicUrl']),
      clientKind: asStringOrNull(map['clientKind']),
      relayCandidate: map['relayCandidate'] == null
          ? null
          : PairingCandidate.fromJson(map['relayCandidate'], 10),
    );
  }
}

class RedeemResult {
  RedeemResult({
    required this.token,
    required this.clientId,
    required this.clientLabel,
    this.serverLabel,
    this.serverUrl,
    this.fingerprint,
  });

  final String token;
  final String clientId;
  final String clientLabel;
  final String? serverLabel;
  final String? serverUrl;
  final String? fingerprint;

  static RedeemResult fromJson(JsonMap map) {
    final client = asMap(map['client']);
    final server = asMap(map['server']);
    return RedeemResult(
      token: asString(map['clientToken']),
      clientId: asString(client['id']),
      clientLabel: asString(client['label'], '这台手机'),
      serverLabel: asStringOrNull(server['label']),
      serverUrl: asStringOrNull(server['url']),
      fingerprint: asStringOrNull(server['fingerprint']),
    );
  }
}

class ModelChoice {
  const ModelChoice({
    required this.provider,
    required this.model,
    this.reasoningEffort,
  });

  final String provider;
  final String model;
  final String? reasoningEffort;

  String get key => '$provider/$model';

  JsonMap toPromptJson() => {
    'provider': provider,
    'model': model,
    if (reasoningEffort != null) 'reasoningEffort': reasoningEffort,
  };
}

class ModelOption {
  const ModelOption({
    required this.id,
    required this.name,
    this.contextWindow,
    this.description,
    this.efforts = const [],
    this.defaultEffort,
  });

  final String id;
  final String name;
  final int? contextWindow;
  final String? description;
  final List<String> efforts;
  final String? defaultEffort;
}

class ModelGroup {
  const ModelGroup({
    required this.id,
    required this.name,
    required this.models,
  });

  final String id;
  final String name;
  final List<ModelOption> models;
}

class ModelCatalog {
  const ModelCatalog({required this.groups});

  final List<ModelGroup> groups;

  bool get isEmpty => groups.every((group) => group.models.isEmpty);

  ModelOption? findModel(ModelChoice selection) {
    for (final group in groups) {
      if (group.id != selection.provider) continue;
      for (final model in group.models) {
        if (model.id == selection.model) return model;
      }
    }
    return null;
  }

  String labelOf(ModelChoice selection) {
    final model = findModel(selection);
    return model?.name ?? selection.model;
  }

  static ModelCatalog fromJson(JsonMap map) {
    final groups = <ModelGroup>[];
    for (final rawGroup in asMapList(map['groups'])) {
      final models = <ModelOption>[];
      for (final rawModel in asMapList(rawGroup['models'])) {
        final reasoning = asMap(rawModel['reasoning']);
        models.add(
          ModelOption(
            id: asString(rawModel['id']),
            name: asString(rawModel['name'], asString(rawModel['id'])),
            contextWindow: asIntOrNull(rawModel['contextWindow']),
            description: asStringOrNull(rawModel['description']),
            efforts: asMapList(reasoning['efforts'])
                .map((entry) => asString(entry['id']))
                .where((value) => value.isNotEmpty)
                .toList(growable: false),
            defaultEffort: asStringOrNull(reasoning['defaultEffort']),
          ),
        );
      }
      groups.add(
        ModelGroup(
          id: asString(rawGroup['id']),
          name: asString(rawGroup['name'], asString(rawGroup['id'])),
          models: models,
        ),
      );
    }
    return ModelCatalog(groups: groups);
  }
}

class ProjectRecord {
  const ProjectRecord({
    required this.id,
    required this.title,
    required this.dirs,
    this.sessionIds = const [],
    this.builtin,
  });

  final String id;
  final String title;
  final List<String> dirs;
  final List<String> sessionIds;
  final String? builtin;

  bool get isDefault => builtin == 'default';

  static ProjectRecord fromJson(JsonMap map) {
    return ProjectRecord(
      id: asString(map['id']),
      title: asString(map['title'], '未命名项目'),
      dirs: asStringList(map['dirs']),
      sessionIds: asStringList(map['sessionIds']),
      builtin: asStringOrNull(map['builtin']),
    );
  }
}

class SessionSummary {
  SessionSummary({
    required this.id,
    required this.createdAt,
    this.updatedAt,
    this.title,
    this.excerpt,
    this.cwd,
    this.projectId,
    this.lastSelection,
    this.agentPreset,
  });

  final String id;
  final DateTime createdAt;
  final DateTime? updatedAt;
  final String? title;
  final String? excerpt;
  final String? cwd;
  final String? projectId;
  final ModelChoice? lastSelection;
  final String? agentPreset;

  DateTime get sortTime => updatedAt ?? createdAt;

  String get displayTitle {
    final heading = title?.trim();
    if (heading != null && heading.isNotEmpty) return heading;
    final firstLine = excerpt?.trim().split('\n').first.trim();
    if (firstLine != null && firstLine.isNotEmpty) {
      return firstLine.length > 60
          ? '${firstLine.substring(0, 60)}…'
          : firstLine;
    }
    return '新会话';
  }

  String get cwdName {
    final path = cwd;
    if (path == null || path.isEmpty) return '';
    final parts = path.split(RegExp(r'[\\/]')).where((part) => part.isNotEmpty);
    return parts.isEmpty ? path : parts.last;
  }

  String get shortId => id.length <= 8 ? id : id.substring(0, 8);

  static SessionSummary fromJson(JsonMap map) {
    final selection = asMap(map['last_selection']);
    final provider = asStringOrNull(selection['provider']);
    final model = asStringOrNull(selection['model']);
    return SessionSummary(
      id: asString(map['id']),
      createdAt:
          asDate(map['created_at']) ?? DateTime.fromMillisecondsSinceEpoch(0),
      updatedAt: asDate(map['updated_at']),
      title: asStringOrNull(map['title']),
      excerpt: asStringOrNull(map['excerpt']),
      cwd: asStringOrNull(map['cwd']),
      projectId: asStringOrNull(map['project_id']),
      lastSelection: provider != null && model != null
          ? ModelChoice(
              provider: provider,
              model: model,
              reasoningEffort: asStringOrNull(selection['reasoningEffort']),
            )
          : null,
      agentPreset: asStringOrNull(map['agent_preset']),
    );
  }
}

class ImageAttachment {
  const ImageAttachment({required this.mime, required this.data, this.path});

  final String mime;
  final String data;
  final String? path;

  static ImageAttachment? fromJson(Object? value) {
    final map = asMap(value);
    final data = asStringOrNull(map['data']);
    if (data == null) return null;
    return ImageAttachment(
      mime: asString(map['mime'], 'image/png'),
      data: data,
      path: asStringOrNull(map['path']),
    );
  }
}

class SessionHeader {
  SessionHeader({
    required this.id,
    required this.cwd,
    required this.createdAt,
    this.projectId,
  });

  final String id;
  final String cwd;
  final DateTime createdAt;
  final String? projectId;

  String get cwdName {
    final parts = cwd.split(RegExp(r'[\\/]')).where((part) => part.isNotEmpty);
    return parts.isEmpty ? cwd : parts.last;
  }

  static SessionHeader fromJson(JsonMap map) {
    return SessionHeader(
      id: asString(map['id']),
      cwd: asString(map['cwd']),
      createdAt:
          asDate(map['created_at']) ?? DateTime.fromMillisecondsSinceEpoch(0),
      projectId: asStringOrNull(map['project_id']),
    );
  }
}

class SessionPage {
  SessionPage({
    required this.header,
    required this.events,
    required this.total,
    required this.hasMoreBefore,
    required this.anchors,
    this.lastSelection,
    this.lastPermission,
  });

  final SessionHeader header;
  final List<JsonMap> events;
  final int total;
  final bool hasMoreBefore;
  final List<int> anchors;
  final ModelChoice? lastSelection;
  final PermissionChoice? lastPermission;

  int get lastSeq => events.isEmpty ? 0 : asInt(events.last['seq']);
}

class SessionEnvelope {
  SessionEnvelope({
    required this.seq,
    required this.time,
    required this.type,
    required this.data,
  });

  final int seq;
  final int time;
  final String type;
  final JsonMap data;

  static SessionEnvelope? fromJson(Object? value) {
    final map = asMap(value);
    final seq = asIntOrNull(map['seq']);
    if (seq == null || seq < 0) return null;
    return SessionEnvelope(
      seq: seq,
      time: asInt(map['time']),
      type: asString(map['type']),
      data: map,
    );
  }
}

/// One batch from `/api/sessions/:id/follow/poll`.
class SessionEventPoll {
  const SessionEventPoll({required this.envelopes, required this.seq});

  final List<JsonMap> envelopes;
  final int seq;
}

/// One batch from `/api/events/poll`.
class GlobalEventPoll {
  const GlobalEventPoll({
    required this.events,
    required this.seq,
    required this.running,
  });

  final List<JsonMap> events;
  final int seq;
  final List<String> running;
}

/// One file the host will restore or delete when rewinding to a checkpoint.
class FileDiffEntry {
  const FileDiffEntry({required this.path, required this.action, this.root});

  final String path;
  final String action;
  final String? root;

  bool get restores => action == 'restore';

  static FileDiffEntry fromJson(Object? value) {
    final map = asMap(value);
    return FileDiffEntry(
      path: asString(map['path']),
      action: asString(map['action']),
      root: asStringOrNull(map['root']),
    );
  }
}

/// The host's physical truncate + file restore result.
class RewindResult {
  const RewindResult({
    required this.toSeq,
    required this.toMessage,
    required this.removedEvents,
    required this.changedFiles,
  });

  final int toSeq;
  final String? toMessage;
  final int removedEvents;
  final List<String> changedFiles;

  static RewindResult fromJson(JsonMap map) {
    return RewindResult(
      toSeq: asInt(map['toSeq']),
      toMessage: asStringOrNull(map['toMessage']),
      removedEvents: asInt(map['removedEvents']),
      changedFiles: asStringList(map['changedFiles']),
    );
  }
}
