window.PROTO_DATA = {
 "storyTimes": [
  "ch-1",
  "ch-2",
  "ch-3",
  "ch-4",
  "ch-5",
  "ch-6"
 ],
 "snapshots": {
  "ch-1": {
   "entities": [
    {
     "entityId": "changan",
     "type": "location",
     "summary": "大唐都城，故事起点",
     "validFrom": "ch-1",
     "validTo": "Infinity",
     "properties": []
    },
    {
     "entityId": "zhaowuji",
     "type": "character",
     "summary": "林墨的师父，青云门长老",
     "validFrom": "ch-1",
     "validTo": "ch-5",
     "properties": [
      {
       "declarationId": "decl-zhaowuji-身份-ch-1",
       "entityId": "zhaowuji",
       "property": "身份",
       "value": "青云门长老",
       "modality": "fact",
       "validFrom": "ch-1",
       "validTo": "ch-4"
      },
      {
       "declarationId": "decl-zhaowuji-姓名-ch-1",
       "entityId": "zhaowuji",
       "property": "姓名",
       "value": "赵无极",
       "modality": "fact",
       "validFrom": "ch-1",
       "validTo": "ch-5"
      }
     ]
    },
    {
     "entityId": "linmo",
     "type": "character",
     "summary": "主角，江湖剑客，背负杀父之仇",
     "validFrom": "ch-1",
     "validTo": "Infinity",
     "properties": [
      {
       "declarationId": "decl-linmo-情绪-ch-1",
       "entityId": "linmo",
       "property": "情绪",
       "value": "平静",
       "modality": "fact",
       "validFrom": "ch-1",
       "validTo": "ch-3"
      },
      {
       "declarationId": "decl-linmo-目标-ch-1",
       "entityId": "linmo",
       "property": "目标",
       "value": "寻找杀父仇人",
       "modality": "fact",
       "validFrom": "ch-1",
       "validTo": "Infinity"
      },
      {
       "declarationId": "decl-linmo-性格-ch-1",
       "entityId": "linmo",
       "property": "性格",
       "value": "沉默寡言",
       "modality": "fact",
       "validFrom": "ch-1",
       "validTo": "Infinity"
      },
      {
       "declarationId": "decl-linmo-身份-ch-1",
       "entityId": "linmo",
       "property": "身份",
       "value": "青云门弟子",
       "modality": "fact",
       "validFrom": "ch-1",
       "validTo": "Infinity"
      },
      {
       "declarationId": "decl-linmo-姓名-ch-1",
       "entityId": "linmo",
       "property": "姓名",
       "value": "林墨",
       "modality": "fact",
       "validFrom": "ch-1",
       "validTo": "Infinity"
      }
     ]
    }
   ],
   "relations": [
    {
     "relationId": "rel-linmo-师徒-zhaowuji-ch-1",
     "sourceId": "linmo",
     "targetId": "zhaowuji",
     "label": "师徒",
     "validFrom": "ch-1",
     "validTo": "ch-4"
    },
    {
     "relationId": "rel-linmo-located_in-changan-ch-1",
     "sourceId": "linmo",
     "targetId": "changan",
     "label": "located_in",
     "validFrom": "ch-1",
     "validTo": "Infinity"
    }
   ]
  },
  "ch-2": {
   "entities": [
    {
     "entityId": "qingshuang",
     "type": "item",
     "summary": "林墨家传佩剑，剑身泛青",
     "validFrom": "ch-2",
     "validTo": "Infinity",
     "properties": [
      {
       "declarationId": "decl-qingshuang-来历-ch-2",
       "entityId": "qingshuang",
       "property": "来历",
       "value": "林家祖传",
       "modality": "fact",
       "validFrom": "ch-2",
       "validTo": "Infinity"
      },
      {
       "declarationId": "decl-qingshuang-名称-ch-2",
       "entityId": "qingshuang",
       "property": "名称",
       "value": "青霜剑",
       "modality": "fact",
       "validFrom": "ch-2",
       "validTo": "Infinity"
      }
     ]
    },
    {
     "entityId": "zuixianlou",
     "type": "location",
     "summary": "长安城内最有名的酒馆",
     "validFrom": "ch-2",
     "validTo": "Infinity",
     "properties": []
    },
    {
     "entityId": "changan",
     "type": "location",
     "summary": "大唐都城，故事起点",
     "validFrom": "ch-1",
     "validTo": "Infinity",
     "properties": []
    },
    {
     "entityId": "zhaowuji",
     "type": "character",
     "summary": "林墨的师父，青云门长老",
     "validFrom": "ch-1",
     "validTo": "ch-5",
     "properties": [
      {
       "declarationId": "decl-zhaowuji-身份-ch-1",
       "entityId": "zhaowuji",
       "property": "身份",
       "value": "青云门长老",
       "modality": "fact",
       "validFrom": "ch-1",
       "validTo": "ch-4"
      },
      {
       "declarationId": "decl-zhaowuji-姓名-ch-1",
       "entityId": "zhaowuji",
       "property": "姓名",
       "value": "赵无极",
       "modality": "fact",
       "validFrom": "ch-1",
       "validTo": "ch-5"
      }
     ]
    },
    {
     "entityId": "linmo",
     "type": "character",
     "summary": "主角，江湖剑客，背负杀父之仇",
     "validFrom": "ch-1",
     "validTo": "Infinity",
     "properties": [
      {
       "declarationId": "decl-linmo-情绪-ch-1",
       "entityId": "linmo",
       "property": "情绪",
       "value": "平静",
       "modality": "fact",
       "validFrom": "ch-1",
       "validTo": "ch-3"
      },
      {
       "declarationId": "decl-linmo-目标-ch-1",
       "entityId": "linmo",
       "property": "目标",
       "value": "寻找杀父仇人",
       "modality": "fact",
       "validFrom": "ch-1",
       "validTo": "Infinity"
      },
      {
       "declarationId": "decl-linmo-性格-ch-1",
       "entityId": "linmo",
       "property": "性格",
       "value": "沉默寡言",
       "modality": "fact",
       "validFrom": "ch-1",
       "validTo": "Infinity"
      },
      {
       "declarationId": "decl-linmo-身份-ch-1",
       "entityId": "linmo",
       "property": "身份",
       "value": "青云门弟子",
       "modality": "fact",
       "validFrom": "ch-1",
       "validTo": "Infinity"
      },
      {
       "declarationId": "decl-linmo-姓名-ch-1",
       "entityId": "linmo",
       "property": "姓名",
       "value": "林墨",
       "modality": "fact",
       "validFrom": "ch-1",
       "validTo": "Infinity"
      }
     ]
    }
   ],
   "relations": [
    {
     "relationId": "rel-zhaowuji-located_in-zuixianlou-ch-2",
     "sourceId": "zhaowuji",
     "targetId": "zuixianlou",
     "label": "located_in",
     "validFrom": "ch-2",
     "validTo": "Infinity"
    },
    {
     "relationId": "rel-linmo-持有-qingshuang-ch-2",
     "sourceId": "linmo",
     "targetId": "qingshuang",
     "label": "持有",
     "validFrom": "ch-2",
     "validTo": "Infinity"
    },
    {
     "relationId": "rel-linmo-师徒-zhaowuji-ch-1",
     "sourceId": "linmo",
     "targetId": "zhaowuji",
     "label": "师徒",
     "validFrom": "ch-1",
     "validTo": "ch-4"
    },
    {
     "relationId": "rel-linmo-located_in-changan-ch-1",
     "sourceId": "linmo",
     "targetId": "changan",
     "label": "located_in",
     "validFrom": "ch-1",
     "validTo": "Infinity"
    }
   ]
  },
  "ch-3": {
   "entities": [
    {
     "entityId": "suwanqing",
     "type": "character",
     "summary": "醉仙楼歌姬，消息灵通",
     "validFrom": "ch-3",
     "validTo": "Infinity",
     "properties": [
      {
       "declarationId": "decl-suwanqing-身份-ch-3",
       "entityId": "suwanqing",
       "property": "身份",
       "value": "醉仙楼歌姬",
       "modality": "fact",
       "validFrom": "ch-3",
       "validTo": "Infinity"
      },
      {
       "declarationId": "decl-suwanqing-姓名-ch-3",
       "entityId": "suwanqing",
       "property": "姓名",
       "value": "苏晚晴",
       "modality": "fact",
       "validFrom": "ch-3",
       "validTo": "Infinity"
      }
     ]
    },
    {
     "entityId": "qingshuang",
     "type": "item",
     "summary": "林墨家传佩剑，剑身泛青",
     "validFrom": "ch-2",
     "validTo": "Infinity",
     "properties": [
      {
       "declarationId": "decl-qingshuang-来历-ch-2",
       "entityId": "qingshuang",
       "property": "来历",
       "value": "林家祖传",
       "modality": "fact",
       "validFrom": "ch-2",
       "validTo": "Infinity"
      },
      {
       "declarationId": "decl-qingshuang-名称-ch-2",
       "entityId": "qingshuang",
       "property": "名称",
       "value": "青霜剑",
       "modality": "fact",
       "validFrom": "ch-2",
       "validTo": "Infinity"
      }
     ]
    },
    {
     "entityId": "zuixianlou",
     "type": "location",
     "summary": "长安城内最有名的酒馆",
     "validFrom": "ch-2",
     "validTo": "Infinity",
     "properties": []
    },
    {
     "entityId": "changan",
     "type": "location",
     "summary": "大唐都城，故事起点",
     "validFrom": "ch-1",
     "validTo": "Infinity",
     "properties": []
    },
    {
     "entityId": "zhaowuji",
     "type": "character",
     "summary": "林墨的师父，青云门长老",
     "validFrom": "ch-1",
     "validTo": "ch-5",
     "properties": [
      {
       "declarationId": "decl-zhaowuji-身份-ch-1",
       "entityId": "zhaowuji",
       "property": "身份",
       "value": "青云门长老",
       "modality": "fact",
       "validFrom": "ch-1",
       "validTo": "ch-4"
      },
      {
       "declarationId": "decl-zhaowuji-姓名-ch-1",
       "entityId": "zhaowuji",
       "property": "姓名",
       "value": "赵无极",
       "modality": "fact",
       "validFrom": "ch-1",
       "validTo": "ch-5"
      }
     ]
    },
    {
     "entityId": "linmo",
     "type": "character",
     "summary": "主角，江湖剑客，背负杀父之仇",
     "validFrom": "ch-1",
     "validTo": "Infinity",
     "properties": [
      {
       "declarationId": "decl-linmo-情绪-ch-3",
       "entityId": "linmo",
       "property": "情绪",
       "value": "愤怒",
       "modality": "fact",
       "validFrom": "ch-3",
       "validTo": "Infinity"
      },
      {
       "declarationId": "decl-linmo-目标-ch-1",
       "entityId": "linmo",
       "property": "目标",
       "value": "寻找杀父仇人",
       "modality": "fact",
       "validFrom": "ch-1",
       "validTo": "Infinity"
      },
      {
       "declarationId": "decl-linmo-性格-ch-1",
       "entityId": "linmo",
       "property": "性格",
       "value": "沉默寡言",
       "modality": "fact",
       "validFrom": "ch-1",
       "validTo": "Infinity"
      },
      {
       "declarationId": "decl-linmo-身份-ch-1",
       "entityId": "linmo",
       "property": "身份",
       "value": "青云门弟子",
       "modality": "fact",
       "validFrom": "ch-1",
       "validTo": "Infinity"
      },
      {
       "declarationId": "decl-linmo-姓名-ch-1",
       "entityId": "linmo",
       "property": "姓名",
       "value": "林墨",
       "modality": "fact",
       "validFrom": "ch-1",
       "validTo": "Infinity"
      }
     ]
    }
   ],
   "relations": [
    {
     "relationId": "rel-suwanqing-located_in-zuixianlou-ch-3",
     "sourceId": "suwanqing",
     "targetId": "zuixianlou",
     "label": "located_in",
     "validFrom": "ch-3",
     "validTo": "Infinity"
    },
    {
     "relationId": "rel-zhaowuji-located_in-zuixianlou-ch-2",
     "sourceId": "zhaowuji",
     "targetId": "zuixianlou",
     "label": "located_in",
     "validFrom": "ch-2",
     "validTo": "Infinity"
    },
    {
     "relationId": "rel-linmo-持有-qingshuang-ch-2",
     "sourceId": "linmo",
     "targetId": "qingshuang",
     "label": "持有",
     "validFrom": "ch-2",
     "validTo": "Infinity"
    },
    {
     "relationId": "rel-linmo-师徒-zhaowuji-ch-1",
     "sourceId": "linmo",
     "targetId": "zhaowuji",
     "label": "师徒",
     "validFrom": "ch-1",
     "validTo": "ch-4"
    },
    {
     "relationId": "rel-linmo-located_in-changan-ch-1",
     "sourceId": "linmo",
     "targetId": "changan",
     "label": "located_in",
     "validFrom": "ch-1",
     "validTo": "Infinity"
    }
   ]
  },
  "ch-4": {
   "entities": [
    {
     "entityId": "mojiao",
     "type": "concept",
     "summary": "神秘邪教组织，疑似与林家灭门有关",
     "validFrom": "ch-4",
     "validTo": "Infinity",
     "properties": []
    },
    {
     "entityId": "suwanqing",
     "type": "character",
     "summary": "醉仙楼歌姬，消息灵通",
     "validFrom": "ch-3",
     "validTo": "Infinity",
     "properties": [
      {
       "declarationId": "decl-suwanqing-身份-ch-3",
       "entityId": "suwanqing",
       "property": "身份",
       "value": "醉仙楼歌姬",
       "modality": "fact",
       "validFrom": "ch-3",
       "validTo": "Infinity"
      },
      {
       "declarationId": "decl-suwanqing-姓名-ch-3",
       "entityId": "suwanqing",
       "property": "姓名",
       "value": "苏晚晴",
       "modality": "fact",
       "validFrom": "ch-3",
       "validTo": "Infinity"
      }
     ]
    },
    {
     "entityId": "qingshuang",
     "type": "item",
     "summary": "林墨家传佩剑，剑身泛青",
     "validFrom": "ch-2",
     "validTo": "Infinity",
     "properties": [
      {
       "declarationId": "decl-qingshuang-来历-ch-2",
       "entityId": "qingshuang",
       "property": "来历",
       "value": "林家祖传",
       "modality": "fact",
       "validFrom": "ch-2",
       "validTo": "Infinity"
      },
      {
       "declarationId": "decl-qingshuang-名称-ch-2",
       "entityId": "qingshuang",
       "property": "名称",
       "value": "青霜剑",
       "modality": "fact",
       "validFrom": "ch-2",
       "validTo": "Infinity"
      }
     ]
    },
    {
     "entityId": "zuixianlou",
     "type": "location",
     "summary": "长安城内最有名的酒馆",
     "validFrom": "ch-2",
     "validTo": "Infinity",
     "properties": []
    },
    {
     "entityId": "changan",
     "type": "location",
     "summary": "大唐都城，故事起点",
     "validFrom": "ch-1",
     "validTo": "Infinity",
     "properties": []
    },
    {
     "entityId": "zhaowuji",
     "type": "character",
     "summary": "林墨的师父，青云门长老",
     "validFrom": "ch-1",
     "validTo": "ch-5",
     "properties": [
      {
       "declarationId": "decl-zhaowuji-身份-ch-4",
       "entityId": "zhaowuji",
       "property": "身份",
       "value": "魔教长老",
       "modality": "belief",
       "validFrom": "ch-4",
       "validTo": "ch-5"
      },
      {
       "declarationId": "decl-zhaowuji-姓名-ch-1",
       "entityId": "zhaowuji",
       "property": "姓名",
       "value": "赵无极",
       "modality": "fact",
       "validFrom": "ch-1",
       "validTo": "ch-5"
      }
     ]
    },
    {
     "entityId": "linmo",
     "type": "character",
     "summary": "主角，江湖剑客，背负杀父之仇",
     "validFrom": "ch-1",
     "validTo": "Infinity",
     "properties": [
      {
       "declarationId": "decl-linmo-情绪-ch-3",
       "entityId": "linmo",
       "property": "情绪",
       "value": "愤怒",
       "modality": "fact",
       "validFrom": "ch-3",
       "validTo": "Infinity"
      },
      {
       "declarationId": "decl-linmo-目标-ch-1",
       "entityId": "linmo",
       "property": "目标",
       "value": "寻找杀父仇人",
       "modality": "fact",
       "validFrom": "ch-1",
       "validTo": "Infinity"
      },
      {
       "declarationId": "decl-linmo-性格-ch-1",
       "entityId": "linmo",
       "property": "性格",
       "value": "沉默寡言",
       "modality": "fact",
       "validFrom": "ch-1",
       "validTo": "Infinity"
      },
      {
       "declarationId": "decl-linmo-身份-ch-1",
       "entityId": "linmo",
       "property": "身份",
       "value": "青云门弟子",
       "modality": "fact",
       "validFrom": "ch-1",
       "validTo": "Infinity"
      },
      {
       "declarationId": "decl-linmo-姓名-ch-1",
       "entityId": "linmo",
       "property": "姓名",
       "value": "林墨",
       "modality": "fact",
       "validFrom": "ch-1",
       "validTo": "Infinity"
      }
     ]
    }
   ],
   "relations": [
    {
     "relationId": "rel-zhaowuji-隶属-mojiao-ch-4",
     "sourceId": "zhaowuji",
     "targetId": "mojiao",
     "label": "隶属",
     "validFrom": "ch-4",
     "validTo": "Infinity"
    },
    {
     "relationId": "rel-suwanqing-located_in-zuixianlou-ch-3",
     "sourceId": "suwanqing",
     "targetId": "zuixianlou",
     "label": "located_in",
     "validFrom": "ch-3",
     "validTo": "Infinity"
    },
    {
     "relationId": "rel-zhaowuji-located_in-zuixianlou-ch-2",
     "sourceId": "zhaowuji",
     "targetId": "zuixianlou",
     "label": "located_in",
     "validFrom": "ch-2",
     "validTo": "Infinity"
    },
    {
     "relationId": "rel-linmo-持有-qingshuang-ch-2",
     "sourceId": "linmo",
     "targetId": "qingshuang",
     "label": "持有",
     "validFrom": "ch-2",
     "validTo": "Infinity"
    },
    {
     "relationId": "rel-linmo-located_in-changan-ch-1",
     "sourceId": "linmo",
     "targetId": "changan",
     "label": "located_in",
     "validFrom": "ch-1",
     "validTo": "Infinity"
    }
   ]
  },
  "ch-5": {
   "entities": [
    {
     "entityId": "mojiao",
     "type": "concept",
     "summary": "神秘邪教组织，疑似与林家灭门有关",
     "validFrom": "ch-4",
     "validTo": "Infinity",
     "properties": []
    },
    {
     "entityId": "suwanqing",
     "type": "character",
     "summary": "醉仙楼歌姬，消息灵通",
     "validFrom": "ch-3",
     "validTo": "Infinity",
     "properties": [
      {
       "declarationId": "decl-suwanqing-身份-ch-3",
       "entityId": "suwanqing",
       "property": "身份",
       "value": "醉仙楼歌姬",
       "modality": "fact",
       "validFrom": "ch-3",
       "validTo": "Infinity"
      },
      {
       "declarationId": "decl-suwanqing-姓名-ch-3",
       "entityId": "suwanqing",
       "property": "姓名",
       "value": "苏晚晴",
       "modality": "fact",
       "validFrom": "ch-3",
       "validTo": "Infinity"
      }
     ]
    },
    {
     "entityId": "qingshuang",
     "type": "item",
     "summary": "林墨家传佩剑，剑身泛青",
     "validFrom": "ch-2",
     "validTo": "Infinity",
     "properties": [
      {
       "declarationId": "decl-qingshuang-来历-ch-2",
       "entityId": "qingshuang",
       "property": "来历",
       "value": "林家祖传",
       "modality": "fact",
       "validFrom": "ch-2",
       "validTo": "Infinity"
      },
      {
       "declarationId": "decl-qingshuang-名称-ch-2",
       "entityId": "qingshuang",
       "property": "名称",
       "value": "青霜剑",
       "modality": "fact",
       "validFrom": "ch-2",
       "validTo": "Infinity"
      }
     ]
    },
    {
     "entityId": "zuixianlou",
     "type": "location",
     "summary": "长安城内最有名的酒馆",
     "validFrom": "ch-2",
     "validTo": "Infinity",
     "properties": []
    },
    {
     "entityId": "changan",
     "type": "location",
     "summary": "大唐都城，故事起点",
     "validFrom": "ch-1",
     "validTo": "Infinity",
     "properties": []
    },
    {
     "entityId": "linmo",
     "type": "character",
     "summary": "主角，江湖剑客，背负杀父之仇",
     "validFrom": "ch-1",
     "validTo": "Infinity",
     "properties": [
      {
       "declarationId": "decl-linmo-情绪-ch-3",
       "entityId": "linmo",
       "property": "情绪",
       "value": "愤怒",
       "modality": "fact",
       "validFrom": "ch-3",
       "validTo": "Infinity"
      },
      {
       "declarationId": "decl-linmo-目标-ch-1",
       "entityId": "linmo",
       "property": "目标",
       "value": "寻找杀父仇人",
       "modality": "fact",
       "validFrom": "ch-1",
       "validTo": "Infinity"
      },
      {
       "declarationId": "decl-linmo-性格-ch-1",
       "entityId": "linmo",
       "property": "性格",
       "value": "沉默寡言",
       "modality": "fact",
       "validFrom": "ch-1",
       "validTo": "Infinity"
      },
      {
       "declarationId": "decl-linmo-身份-ch-1",
       "entityId": "linmo",
       "property": "身份",
       "value": "青云门弟子",
       "modality": "fact",
       "validFrom": "ch-1",
       "validTo": "Infinity"
      },
      {
       "declarationId": "decl-linmo-姓名-ch-1",
       "entityId": "linmo",
       "property": "姓名",
       "value": "林墨",
       "modality": "fact",
       "validFrom": "ch-1",
       "validTo": "Infinity"
      }
     ]
    }
   ],
   "relations": [
    {
     "relationId": "rel-linmo-打听消息-suwanqing-ch-5",
     "sourceId": "linmo",
     "targetId": "suwanqing",
     "label": "打听消息",
     "validFrom": "ch-5",
     "validTo": "Infinity"
    },
    {
     "relationId": "rel-linmo-调查-mojiao-ch-5",
     "sourceId": "linmo",
     "targetId": "mojiao",
     "label": "调查",
     "validFrom": "ch-5",
     "validTo": "Infinity"
    },
    {
     "relationId": "rel-zhaowuji-隶属-mojiao-ch-4",
     "sourceId": "zhaowuji",
     "targetId": "mojiao",
     "label": "隶属",
     "validFrom": "ch-4",
     "validTo": "Infinity"
    },
    {
     "relationId": "rel-suwanqing-located_in-zuixianlou-ch-3",
     "sourceId": "suwanqing",
     "targetId": "zuixianlou",
     "label": "located_in",
     "validFrom": "ch-3",
     "validTo": "Infinity"
    },
    {
     "relationId": "rel-zhaowuji-located_in-zuixianlou-ch-2",
     "sourceId": "zhaowuji",
     "targetId": "zuixianlou",
     "label": "located_in",
     "validFrom": "ch-2",
     "validTo": "Infinity"
    },
    {
     "relationId": "rel-linmo-持有-qingshuang-ch-2",
     "sourceId": "linmo",
     "targetId": "qingshuang",
     "label": "持有",
     "validFrom": "ch-2",
     "validTo": "Infinity"
    },
    {
     "relationId": "rel-linmo-located_in-changan-ch-1",
     "sourceId": "linmo",
     "targetId": "changan",
     "label": "located_in",
     "validFrom": "ch-1",
     "validTo": "Infinity"
    }
   ]
  },
  "ch-6": {
   "entities": [
    {
     "entityId": "mojiao",
     "type": "concept",
     "summary": "神秘邪教组织，疑似与林家灭门有关",
     "validFrom": "ch-4",
     "validTo": "Infinity",
     "properties": []
    },
    {
     "entityId": "suwanqing",
     "type": "character",
     "summary": "醉仙楼歌姬，消息灵通",
     "validFrom": "ch-3",
     "validTo": "Infinity",
     "properties": [
      {
       "declarationId": "decl-suwanqing-身份-ch-3",
       "entityId": "suwanqing",
       "property": "身份",
       "value": "醉仙楼歌姬",
       "modality": "fact",
       "validFrom": "ch-3",
       "validTo": "Infinity"
      },
      {
       "declarationId": "decl-suwanqing-姓名-ch-3",
       "entityId": "suwanqing",
       "property": "姓名",
       "value": "苏晚晴",
       "modality": "fact",
       "validFrom": "ch-3",
       "validTo": "Infinity"
      }
     ]
    },
    {
     "entityId": "qingshuang",
     "type": "item",
     "summary": "林墨家传佩剑，剑身泛青",
     "validFrom": "ch-2",
     "validTo": "Infinity",
     "properties": [
      {
       "declarationId": "decl-qingshuang-来历-ch-2",
       "entityId": "qingshuang",
       "property": "来历",
       "value": "林家祖传",
       "modality": "fact",
       "validFrom": "ch-2",
       "validTo": "Infinity"
      },
      {
       "declarationId": "decl-qingshuang-名称-ch-2",
       "entityId": "qingshuang",
       "property": "名称",
       "value": "青霜剑",
       "modality": "fact",
       "validFrom": "ch-2",
       "validTo": "Infinity"
      }
     ]
    },
    {
     "entityId": "zuixianlou",
     "type": "location",
     "summary": "长安城内最有名的酒馆",
     "validFrom": "ch-2",
     "validTo": "Infinity",
     "properties": []
    },
    {
     "entityId": "changan",
     "type": "location",
     "summary": "大唐都城，故事起点",
     "validFrom": "ch-1",
     "validTo": "Infinity",
     "properties": []
    },
    {
     "entityId": "linmo",
     "type": "character",
     "summary": "主角，江湖剑客，背负杀父之仇",
     "validFrom": "ch-1",
     "validTo": "Infinity",
     "properties": [
      {
       "declarationId": "decl-linmo-情绪-ch-3",
       "entityId": "linmo",
       "property": "情绪",
       "value": "愤怒",
       "modality": "fact",
       "validFrom": "ch-3",
       "validTo": "Infinity"
      },
      {
       "declarationId": "decl-linmo-目标-ch-1",
       "entityId": "linmo",
       "property": "目标",
       "value": "寻找杀父仇人",
       "modality": "fact",
       "validFrom": "ch-1",
       "validTo": "Infinity"
      },
      {
       "declarationId": "decl-linmo-性格-ch-1",
       "entityId": "linmo",
       "property": "性格",
       "value": "沉默寡言",
       "modality": "fact",
       "validFrom": "ch-1",
       "validTo": "Infinity"
      },
      {
       "declarationId": "decl-linmo-身份-ch-1",
       "entityId": "linmo",
       "property": "身份",
       "value": "青云门弟子",
       "modality": "fact",
       "validFrom": "ch-1",
       "validTo": "Infinity"
      },
      {
       "declarationId": "decl-linmo-姓名-ch-1",
       "entityId": "linmo",
       "property": "姓名",
       "value": "林墨",
       "modality": "fact",
       "validFrom": "ch-1",
       "validTo": "Infinity"
      }
     ]
    }
   ],
   "relations": [
    {
     "relationId": "rel-linmo-打听消息-suwanqing-ch-5",
     "sourceId": "linmo",
     "targetId": "suwanqing",
     "label": "打听消息",
     "validFrom": "ch-5",
     "validTo": "Infinity"
    },
    {
     "relationId": "rel-linmo-调查-mojiao-ch-5",
     "sourceId": "linmo",
     "targetId": "mojiao",
     "label": "调查",
     "validFrom": "ch-5",
     "validTo": "Infinity"
    },
    {
     "relationId": "rel-zhaowuji-隶属-mojiao-ch-4",
     "sourceId": "zhaowuji",
     "targetId": "mojiao",
     "label": "隶属",
     "validFrom": "ch-4",
     "validTo": "Infinity"
    },
    {
     "relationId": "rel-suwanqing-located_in-zuixianlou-ch-3",
     "sourceId": "suwanqing",
     "targetId": "zuixianlou",
     "label": "located_in",
     "validFrom": "ch-3",
     "validTo": "Infinity"
    },
    {
     "relationId": "rel-zhaowuji-located_in-zuixianlou-ch-2",
     "sourceId": "zhaowuji",
     "targetId": "zuixianlou",
     "label": "located_in",
     "validFrom": "ch-2",
     "validTo": "Infinity"
    },
    {
     "relationId": "rel-linmo-持有-qingshuang-ch-2",
     "sourceId": "linmo",
     "targetId": "qingshuang",
     "label": "持有",
     "validFrom": "ch-2",
     "validTo": "Infinity"
    },
    {
     "relationId": "rel-linmo-located_in-changan-ch-1",
     "sourceId": "linmo",
     "targetId": "changan",
     "label": "located_in",
     "validFrom": "ch-1",
     "validTo": "Infinity"
    }
   ]
  }
 },
 "events": [
  {
   "eventId": "e01",
   "type": "birth",
   "storyTime": "ch-1",
   "entityId": "linmo",
   "source": "engine",
   "entityType": "character",
   "summary": "主角，江湖剑客，背负杀父之仇",
   "newFacts": [
    {
     "entityId": "linmo",
     "property": "姓名",
     "value": "林墨",
     "modality": "fact"
    },
    {
     "entityId": "linmo",
     "property": "身份",
     "value": "青云门弟子",
     "modality": "fact"
    },
    {
     "entityId": "linmo",
     "property": "性格",
     "value": "沉默寡言",
     "modality": "fact"
    },
    {
     "entityId": "linmo",
     "property": "目标",
     "value": "寻找杀父仇人",
     "modality": "fact"
    },
    {
     "entityId": "linmo",
     "property": "情绪",
     "value": "平静",
     "modality": "fact"
    }
   ]
  },
  {
   "eventId": "e02",
   "type": "birth",
   "storyTime": "ch-1",
   "entityId": "zhaowuji",
   "source": "engine",
   "entityType": "character",
   "summary": "林墨的师父，青云门长老",
   "newFacts": [
    {
     "entityId": "zhaowuji",
     "property": "姓名",
     "value": "赵无极",
     "modality": "fact"
    },
    {
     "entityId": "zhaowuji",
     "property": "身份",
     "value": "青云门长老",
     "modality": "fact"
    }
   ]
  },
  {
   "eventId": "e03",
   "type": "birth",
   "storyTime": "ch-1",
   "entityId": "changan",
   "source": "engine",
   "entityType": "location",
   "summary": "大唐都城，故事起点"
  },
  {
   "eventId": "e04",
   "type": "birth",
   "storyTime": "ch-2",
   "entityId": "zuixianlou",
   "source": "engine",
   "entityType": "location",
   "summary": "长安城内最有名的酒馆"
  },
  {
   "eventId": "e05",
   "type": "birth",
   "storyTime": "ch-2",
   "entityId": "qingshuang",
   "source": "engine",
   "entityType": "item",
   "summary": "林墨家传佩剑，剑身泛青",
   "newFacts": [
    {
     "entityId": "qingshuang",
     "property": "名称",
     "value": "青霜剑",
     "modality": "fact"
    },
    {
     "entityId": "qingshuang",
     "property": "来历",
     "value": "林家祖传",
     "modality": "fact"
    }
   ]
  },
  {
   "eventId": "e06",
   "type": "birth",
   "storyTime": "ch-3",
   "entityId": "suwanqing",
   "source": "engine",
   "entityType": "character",
   "summary": "醉仙楼歌姬，消息灵通",
   "newFacts": [
    {
     "entityId": "suwanqing",
     "property": "姓名",
     "value": "苏晚晴",
     "modality": "fact"
    },
    {
     "entityId": "suwanqing",
     "property": "身份",
     "value": "醉仙楼歌姬",
     "modality": "fact"
    }
   ]
  },
  {
   "eventId": "e07",
   "type": "change",
   "storyTime": "ch-3",
   "entityId": "linmo",
   "source": "engine",
   "invalidated": [
    {
     "declarationId": "decl-linmo-情绪-ch-1",
     "property": "情绪"
    }
   ],
   "newFacts": [
    {
     "entityId": "linmo",
     "property": "情绪",
     "value": "愤怒",
     "modality": "fact"
    }
   ],
   "causedBy": "e01"
  },
  {
   "eventId": "e08",
   "type": "birth",
   "storyTime": "ch-4",
   "entityId": "mojiao",
   "source": "engine",
   "entityType": "concept",
   "summary": "神秘邪教组织，疑似与林家灭门有关"
  },
  {
   "eventId": "e09",
   "type": "change",
   "storyTime": "ch-4",
   "entityId": "zhaowuji",
   "source": "engine",
   "invalidated": [
    {
     "declarationId": "decl-zhaowuji-身份-ch-1",
     "property": "身份"
    }
   ],
   "newFacts": [
    {
     "entityId": "zhaowuji",
     "property": "身份",
     "value": "魔教长老",
     "modality": "belief"
    }
   ],
   "causedBy": "e08"
  },
  {
   "eventId": "e10",
   "type": "death",
   "storyTime": "ch-5",
   "entityId": "zhaowuji",
   "source": "engine",
   "causedBy": "e09"
  }
 ]
};
