import type { Language } from '../shared/types';

export const workspaceCopy = {
  zh: {
    navigation: '主导航', menu: '打开侧边栏', closeMenu: '关闭侧边栏', call: '语音陪伴', records: '状态记录', privacy: '记忆与隐私', account: '账户设置',
    logout: '退出登录', loggingOut: '正在退出…', signedIn: '当前账号', ongoing: '通话进行中', returnCall: '返回通话',
    recordsTitle: '回看，你走过的每一天。', recordsIntro: '这里展示你在对话中的自述和 AI 整理的摘要。可以查看原文，了解每条记录的来源。',
    recordsNote: '这些内容用于个人回顾，不是临床诊断或发作评分。', storage: '按账号保存在当前浏览器，不跨设备同步。',
    saved: '已保存的对话', summarized: '已整理的摘要', memoryOff: '记忆保存已关闭；已有记录仍可查看。',
    emptyTitle: '你的记录，会在这里慢慢积累。', emptyText: '允许保存记忆后，通话结束时会整理本次对话。未开启时，不会自动留下记录。',
    manageMemory: '管理记忆保存', privacyTitle: '记住什么，由你决定。', privacyIntro: '允许保存后，对话、自述和偏好才会用于未来交流。你可以修正记忆或删除记录。',
    accountTitle: '你的 WhiteMood 账号', activeRecord: '本次通话尚未结束',
  },
  en: {
    navigation: 'Main navigation', menu: 'Open sidebar', closeMenu: 'Close sidebar', call: 'Voice companion', records: 'Your records', privacy: 'Memory & privacy', account: 'Account settings',
    logout: 'Sign out', loggingOut: 'Signing out…', signedIn: 'Signed in as', ongoing: 'Call in progress', returnCall: 'Return to call',
    recordsTitle: 'A little space to look back.', recordsIntro: 'Read what you shared and the summaries prepared from your conversations. Open the transcript to see each record’s source.',
    recordsNote: 'For personal reflection, not a diagnosis or episode score.', storage: 'Kept by account in this browser. No cross-device sync.',
    saved: 'Saved conversations', summarized: 'Completed summaries', memoryOff: 'Memory saving is off. Existing records are still available.',
    emptyTitle: 'Your records will grow here.', emptyText: 'With memory enabled, each completed conversation can be summarized here. Nothing is saved automatically while memory is off.',
    manageMemory: 'Manage memory saving', privacyTitle: 'You choose what stays.', privacyIntro: 'When you allow memory, conversations, personal accounts and preferences can help future calls. You can edit memories or delete records.',
    accountTitle: 'Your WhiteMood account', activeRecord: 'This call has not ended yet',
  },
  ko: {
    navigation: '주 메뉴', menu: '사이드바 열기', closeMenu: '사이드바 닫기', call: '음성 동반자', records: '마음 기록', privacy: '기억과 개인정보', account: '계정 설정',
    logout: '로그아웃', loggingOut: '로그아웃 중…', signedIn: '현재 계정', ongoing: '통화 중', returnCall: '통화로 돌아가기',
    recordsTitle: '지나온 하루를 돌아봐요.', recordsIntro: '대화에서 직접 나눈 이야기와 AI가 정리한 요약을 확인해요. 대화 원문에서 각 기록의 출처를 볼 수 있어요.',
    recordsNote: '개인적인 회고를 위한 내용이며, 진단이나 기분 삽화 점수가 아닙니다.', storage: '계정별로 이 브라우저에 저장되며 기기 간 동기화되지 않아요.',
    saved: '저장된 대화', summarized: '정리된 요약', memoryOff: '기억 저장이 꺼져 있어요. 기존 기록은 볼 수 있어요.',
    emptyTitle: '나만의 기록이 천천히 쌓여요.', emptyText: '기억 저장을 허용하면 통화 후 이야기를 정리해요. 기억이 꺼져 있으면 자동으로 저장하지 않아요.',
    manageMemory: '기억 저장 관리', privacyTitle: '무엇을 기억할지 직접 정해요.', privacyIntro: '저장을 허용한 대화와 직접 나눈 이야기, 선호만 다음 대화에 참고해요. 기억을 수정하거나 기록을 지울 수 있어요.',
    accountTitle: '나의 WhiteMood 계정', activeRecord: '아직 진행 중인 통화예요',
  },
} satisfies Record<Language, Record<string, string>>;
